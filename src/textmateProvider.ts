import { Disposable, Document, Extension, extensions, OutputChannel, Position, Range, workspace } from 'coc.nvim'
import fs from 'fs'
import { parse, ParseError } from 'jsonc-parser'
import path from 'path'
import BaseProvider, { Config } from './baseProvider'
import { Snippet, SnippetEdit, TriggerKind } from './types'
import { distinct } from './util'

export interface ISnippetPluginContribution {
  prefix: string | string[]
  body: string | string[]
  description: string | string[]
}

export interface SnippetItem {
  languageId: string
  filepath: string
}

export interface SnippetCache {
  [language: string]: Snippet[]
}

interface KeyToSnippet {
  [key: string]: ISnippetPluginContribution
}

export class TextmateProvider extends BaseProvider {
  private loadedSnippets: SnippetCache = {}
  private loadedLanguageIds: Set<string> = new Set()
  private definitions: Map<string, SnippetItem[]> = new Map()

  constructor(
    private channel: OutputChannel,
    config: Config,
    private subscriptions: Disposable[]
  ) {
    super(config)
  }

  public async init(): Promise<void> {
    if (this.config.loadFromExtensions) {
      for (let extension of extensions.all) {
        await this.loadSnippetDefinition(extension)
      }
      extensions.onDidLoadExtension(extension => {
        this.loadSnippetDefinition(extension).then(items => {
          if (items?.length) {
            items = items.filter(o => workspace.languageIds.has(o.languageId))
            this.loadSnippetsFromDefinition(extension.id, items)
          }
        }, e => {
          this.channel.appendLine(`[Error] ${e.message}`)
        })
      }, null, this.subscriptions)
      extensions.onDidUnloadExtension(id => {
        for (let [key, val] of Object.entries(this.loadedSnippets)) {
          let filtered = val.filter(o => o.extensionId !== id)
          this.loadedSnippets[key] = filtered
        }
      }, null, this.subscriptions)
    }
    let paths = this.config.snippetsRoots as string[]
    for (let dir of paths ?? []) {
      await this.loadDefinitionFromRoot(dir)
    }
    for (let languageId of workspace.languageIds) {
      await this.loadByLanguageId(languageId)
    }
    workspace.onDidOpenTextDocument(e => {
      this.loadByLanguageId(e.languageId)
    }, null, this.subscriptions)
  }

  private async loadByLanguageId(languageId: string): Promise<void> {
    if (this.loadedLanguageIds.has(languageId)) return
    let filetypes = this.getFiletypes(languageId)
    this.channel.appendLine(`Load textmate snippets from filetypes: ${filetypes.join(', ')}`)
    let loaded = this.loadedSnippets
    for (let languageId of filetypes) {
      if (this.loadedLanguageIds.has(languageId)) continue
      this.loadedLanguageIds.add(languageId)
      let snippets: Snippet[] = []
      for (let [extensionId, items] of this.definitions.entries()) {
        for (let item of items) {
          if (item.languageId !== languageId) continue
          let arr = await this.loadSnippetsFromFile(item.filepath, extensionId)
          if (arr) snippets.push(...arr)
        }
      }
      loaded[languageId] = snippets
    }
  }


  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    let filepaths: string[] = []
    for (let filetype of filetypes) {
      let snippets = this.loadedSnippets[filetype]
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
    for (let filetype of filetypes) {
      let snippets = this.loadedSnippets[filetype]
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

  private async loadSnippetDefinition(extension: Extension<any>): Promise<SnippetItem[]> {
    let { packageJSON } = extension
    const arr: SnippetItem[] = []
    if (packageJSON.contributes && packageJSON.contributes.snippets) {
      let { snippets } = packageJSON.contributes
      const extensionId = extension.id
      for (let item of snippets) {
        let p = path.join(extension.extensionPath, item.path)
        if (fs.existsSync(p)) {
          let languages = typeof item.language == 'string' ? [item.language] : item.language
          languages.forEach((language: string) => {
            arr.push({
              languageId: language,
              filepath: p
            })
          })
        }
      }
      if (snippets && snippets.length) {
        this.definitions.set(extensionId, arr)
      }
    }
    return arr
  }

  private async loadDefinitionFromRoot(root: string): Promise<void> {
    root = workspace.expand(root)
    if (!fs.existsSync(root)) return
    let files = await fs.promises.readdir(root, 'utf8')
    files = files.filter(f => f.endsWith('.json') || f.endsWith('.code-snippets'))
    let items: SnippetItem[] = []
    for (let file of files) {
      let filepath = path.join(root, file)
      let basename = path.basename(file, '.json')
      let languageId = basename.replace(/\.code-snippets$/, '')
      items.push({ languageId, filepath })
    }
    this.definitions.set('user-snippets', items)
  }

  private async loadSnippetsFromDefinition(extensionId: string, items: SnippetItem[]): Promise<void> {
    for (let item of items) {
      let { languageId } = item
      if (!fs.existsSync(item.filepath)) continue
      let arr = await this.loadSnippetsFromFile(item.filepath, extensionId)
      let curr = this.loadedSnippets[languageId] || []
      if (arr.length) {
        curr.push(...arr)
        this.loadedSnippets[languageId] = curr
      }
    }
  }

  private async loadSnippetsFromFile(snippetFilePath: string, extensionId: string): Promise<Snippet[]> {
    const contents = await new Promise<string>((resolve, reject) => {
      fs.readFile(snippetFilePath, "utf8", (err, data) => {
        if (err) return reject(err)
        resolve(data)
      })
    })
    const snippets = this.loadSnippetsFromText(snippetFilePath, contents)
    this.channel.appendLine(`[Info ${(new Date()).toISOString()}] Loaded ${snippets.length} textmate snippets from ${snippetFilePath}`)
    return snippets.map(o => Object.assign({ extensionId }, o))
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
    const normalizedSnippets: Snippet[] = []
    snippets.forEach((snip: ISnippetPluginContribution) => {
      if (!snip.prefix) return
      let prefixs = Array.isArray(snip.prefix) ? snip.prefix : [snip.prefix]
      prefixs.forEach(prefix => {
        normalizedSnippets.push({
          filepath,
          lnum: 0,
          body: typeof snip.body === 'string' ? snip.body : snip.body.join('\n'),
          prefix,
          description: typeof snip.description === 'string' ? snip.description : typeof snip.description !== 'undefined' ? snip.description.join('\n') : '',
          triggerKind: TriggerKind.WordBoundary
        })
      })
    })
    return normalizedSnippets
  }
}
