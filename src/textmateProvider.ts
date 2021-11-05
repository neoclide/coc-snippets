import { Document, Extension, extensions, OutputChannel, Position, Range } from 'coc.nvim'
import fs from 'fs'
import { parse, ParseError } from 'jsonc-parser'
import os from 'os'
import path from 'path'
import util from 'util'
import BaseProvider, { Config } from './baseProvider'
import { Snippet, SnippetEdit, TriggerKind } from './types'
import { distinct } from './util'

export interface ISnippetPluginContribution {
  prefix: string
  body: string | string[]
  description: string | string[]
}

export interface SnippetItem {
  languageId: string
  filepath: string
}

export interface SnippetDefinition {
  extensionId: string
  // path => languageIds
  snippets: SnippetItem[]
}

export interface SnippetCache {
  [language: string]: Snippet[]
}

export interface ExtensionCache {
  [id: string]: SnippetCache
}

interface KeyToSnippet {
  [key: string]: ISnippetPluginContribution
}

export class TextmateProvider extends BaseProvider {
  private _snippetCache: ExtensionCache = {}
  private _userSnippets: SnippetCache = {}

  constructor(private channel: OutputChannel, private trace: string, config: Config) {
    super(config)
    if (config.loadFromExtensions) {
      extensions.onDidLoadExtension(extension => {
        this.loadSnippetsFromExtension(extension).catch(e => {
          channel.appendLine(`[Error] ${e.message}`)
        })
      })
      extensions.onDidUnloadExtension(id => {
        delete this._snippetCache[id]
      })
    }
  }

  public async init(): Promise<void> {
    if (this.config.loadFromExtensions) {
      for (let extension of extensions.all) {
        await this.loadSnippetsFromExtension(extension)
      }
    }
    let paths = this.config.snippetsRoots as string[]
    if (paths && paths.length) {
      for (let dir of paths) {
        await this.loadSnippetsFromRoot(dir)
      }
    }
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    let filepaths: string[] = []
    if (this.config.loadFromExtensions) {
      for (let key of Object.keys(this._snippetCache)) {
        let cache = this._snippetCache[key]
        for (let filetype of filetypes) {
          let snippets = cache[filetype]
          if (snippets && snippets.length) {
            filepaths.push(snippets[0].filepath)
          }
        }
      }
    }
    for (let filetype of filetypes) {
      let snippets = this._userSnippets[filetype]
      if (snippets && snippets.length) {
        for (let snip of snippets) {
          let { filepath } = snip
          if (filepaths.indexOf(filepath) == -1) {
            filepaths.push(filepath)
          }
        }
      }
    }
    return distinct(filepaths)
  }

  public async getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]> {
    if (autoTrigger) return []
    let line = document.getline(position.line)
    line = line.slice(0, position.character)
    let snippets = await this.getSnippets(document.filetype)
    if (!snippets || !snippets.length) return []
    let edits: SnippetEdit[] = []
    for (let snip of snippets) {
      let { prefix } = snip
      if (!line.endsWith(prefix)) continue
      let pre = line.slice(0, line.length - prefix.length)
      // not allowed after word
      if (pre.length && /\w/.test(pre[pre.length - 1])) continue
      edits.push({
        prefix,
        range: Range.create(position.line, position.character - prefix.length, position.line, position.character),
        newText: snip.body,
        location: snip.filepath,
        description: snip.description,
        priority: -1
      })
    }
    return edits
  }

  public async getSnippets(filetype: string): Promise<Snippet[]> {
    let res: Snippet[] = []
    let filetypes: string[] = this.getFiletypes(filetype)
    let added: Set<string> = new Set()
    for (let key of Object.keys(this._snippetCache)) {
      let cache = this._snippetCache[key]
      for (let filetype of filetypes) {
        let snippets = cache[filetype]
        if (snippets) {
          for (let snip of snippets) {
            if (!added.has(snip.prefix)) {
              added.add(snip.prefix)
              res.push(snip)
            }
          }
        }
      }
    }
    for (let filetype of filetypes) {
      let snippets = this._userSnippets[filetype]
      if (snippets && snippets.length) {
        for (let snip of snippets) {
          if (!added.has(snip.prefix)) {
            added.add(snip.prefix)
            res.push(snip)
          }
        }
      }
    }
    return res
  }

  public async resolveSnippetBody(snip: Snippet, _range: Range): Promise<string> {
    return snip.body
  }

  private async loadSnippetsFromExtension(extension: Extension<any>): Promise<void> {
    let { packageJSON } = extension
    if (packageJSON.contributes && packageJSON.contributes.snippets) {
      let { snippets } = packageJSON.contributes
      let def: SnippetDefinition = {
        extensionId: extension.id,
        snippets: []
      }
      for (let item of snippets) {
        let p = path.join(extension.extensionPath, item.path)
        let languages = typeof item.language == 'string' ? [item.language] : item.language
        languages.forEach((language: string) => {
          def.snippets.push({
            languageId: language,
            filepath: p
          })
        })
      }
      if (snippets && snippets.length) {
        await this.loadSnippetsFromDefinition(def)
      }
    }
  }

  private async loadSnippetsFromRoot(root: string): Promise<void> {
    let { _userSnippets } = this
    if (root.startsWith('~')) root = root.replace(/^~/, os.homedir())
    let files = await util.promisify(fs.readdir)(root, 'utf8')
    files = files.filter(f => f.endsWith('.json') || f.endsWith('.code-snippets'))
    await Promise.all(files.map(file => {
      file = path.join(root, file)
      let basename = path.basename(file, '.json')
      basename = basename.replace(/\.code-snippets$/, '')
      return this.loadSnippetsFromFile(file).then(snippets => {
        _userSnippets[basename] = snippets
      })
    }))
  }

  private async loadSnippetsFromDefinition(def: SnippetDefinition): Promise<void> {
    let { extensionId, snippets } = def
    let cache = this._snippetCache[extensionId] = {}
    for (let item of snippets) {
      let { languageId } = item
      if (!fs.existsSync(item.filepath)) continue
      let arr = await this.loadSnippetsFromFile(item.filepath)
      let exists = cache[languageId] || []
      cache[languageId] = [...exists, ...arr]
    }
  }

  private async loadSnippetsFromFile(snippetFilePath: string): Promise<Snippet[]> {
    const contents = await new Promise<string>((resolve, reject) => {
      fs.readFile(snippetFilePath, "utf8", (err, data) => {
        if (err) return reject(err)
        resolve(data)
      })
    })
    const snippets = this.loadSnippetsFromText(snippetFilePath, contents)
    this.channel.appendLine(`[Info ${(new Date()).toISOString()}] Loaded ${snippets.length} textmate snippets from ${snippetFilePath}`)
    return snippets
  }

  private loadSnippetsFromText(filepath: string, contents: string): Snippet[] {
    let snippets: ISnippetPluginContribution[] = []
    try {
      let errors: ParseError[] = []
      let snippetObject = parse(contents, errors, { allowTrailingComma: true }) as KeyToSnippet
      if (errors.length) {
        this.channel.appendLine(`[Error ${(new Date()).toLocaleDateString()}] parser error of ${filepath}: ${JSON.stringify(errors, null, 2)}`)
      }
      if (snippetObject) {
        for (let key of Object.keys(snippetObject)) {
          snippets.push(snippetObject[key])
        }
      }
    } catch (ex) {
      this.channel.appendLine(`[Error ${(new Date()).toLocaleDateString()}] ${ex.stack}`)
      snippets = []
    }
    const normalizedSnippets = snippets.map((snip: ISnippetPluginContribution): Snippet => {
      let prefix = Array.isArray(snip.prefix) ? snip.prefix[0] : snip.prefix
      return {
        filepath,
        lnum: 0,
        body: typeof snip.body === 'string' ? snip.body : snip.body.join('\n'),
        prefix,
        description: typeof snip.description === 'string' ? snip.description : typeof snip.description !== 'undefined' ? snip.description.join('\n') : '',
        triggerKind: TriggerKind.WordBoundary
      }
    },
    )
    return normalizedSnippets
  }
}
