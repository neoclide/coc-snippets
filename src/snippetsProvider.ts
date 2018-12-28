import fs from 'fs'
import { parse, ParseError } from 'jsonc-parser'
import os from 'os'
import path from 'path'
import { extensions, Extension, OutputChannel, Document } from 'coc.nvim'
import { Snippet, Provider, TriggerKind, SnippetsConfig, SnippetEdit, GlobalContext } from './types'
import { Position, CompletionItem, Range } from 'vscode-languageserver-types'

export interface ISnippetPluginContribution {
  prefix: string
  body: string[]
  description: string
}

export interface SnippetDefinition {
  extensionId: string
  // path => languageIds
  snippets: Map<string, string[]>
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

export class SnippetsProvider implements Provider {
  private _snippetCache: ExtensionCache = {}

  constructor(private channel: OutputChannel, private config: SnippetsConfig) {
    extensions.onDidLoadExtension(extension => {
      this.loadSnippetsFromExtension(extension).catch(e => {
        channel.appendLine(`[Error] ${e.message}`)
      })
    })
    extensions.onDidUnloadExtension(id => {
      delete this._snippetCache[id]
    })
  }

  public async init(): Promise<void> {
    for (let extension of extensions.all) {
      await this.loadSnippetsFromExtension(extension)
    }
  }

  public getSnippetFiles(_filetype: string): string[] {
    // let files: Set<string> = new Set()
    // let snippets = this.getSnippets(filetype)
    // for (let snip of snippets) {
    //   files.add(snip.filepath)
    // }
    // return Array.from(files)
    return []
  }

  public async getTriggerSnippets(document: Document, position: Position): Promise<SnippetEdit[]> {
    let line = document.getline(position.line)
    line = line.slice(0, position.character)
    let snippets = this.getSnippets(document.filetype)
    if (!snippets || !snippets.length) return []
    let edits: SnippetEdit[] = []
    for (let snip of snippets) {
      let { prefix } = snip
      if (!line.endsWith(prefix)) continue
      let pre = line.slice(0, line.length - prefix.length)
      // only allow in line begin
      if (pre.trim().length) continue
      edits.push({
        range: Range.create(position.line, position.character - prefix.length, position.line, position.character),
        newText: snip.body,
        location: snip.filepath,
        description: snip.description
      })
    }
    return edits
  }

  public getSnippets(filetype: string): Snippet[] {
    let res: Snippet[] = []
    let filetypes: string[] = [filetype]
    if (this.config.extends[filetype] != null) {
      filetypes.push(...this.config.extends[filetype])
    }
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
    return res
  }

  public async resolveSnippetBody(item: CompletionItem, _context: GlobalContext): Promise<string> {
    return item.data.body
  }

  private async loadSnippetsFromExtension(extension: Extension<any>): Promise<void> {
    let { packageJSON } = extension
    if (packageJSON.contributes && packageJSON.contributes.snippets) {
      let { snippets } = packageJSON.contributes
      let map: Map<string, string[]> = new Map()
      let def: SnippetDefinition = {
        extensionId: extension.id,
        snippets: map
      }
      for (let item of snippets) {
        let p = path.join(extension.extensionPath, item.path)
        let { language } = item
        let ids: string[] = map.get(p) || []
        ids.push(language)
        map.set(p, ids)
      }
      if (snippets && snippets.length) {
        await this.loadSnippetsFromDefinition(def)
      }
    }
  }

  private async loadSnippetsFromDefinition(def: SnippetDefinition): Promise<void> {
    let { extensionId, snippets } = def
    let cache = this._snippetCache[extensionId] = {}
    for (let path of snippets.keys()) {
      let arr = await this.loadSnippetsFromFile(path)
      let languageIds = snippets.get(path)
      for (let id of languageIds) {
        cache[id] = arr
      }
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
    this.channel.appendLine(`[Info ${(new Date()).toLocaleDateString()}] Loaded ${snippets.length} snippets from ${snippetFilePath}`)
    return snippets
  }

  private loadSnippetsFromText(filepath: string, contents: string): Snippet[] {
    let snippets: ISnippetPluginContribution[] = []
    try {
      let errors: ParseError[] = []
      let snippetObject = parse(contents, errors, { allowTrailingComma: true }) as KeyToSnippet
      if (errors.length) {
        this.channel.appendLine(`[Error ${(new Date()).toLocaleDateString()}] parser error: ${errors[0].error}`)
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
      return {
        filepath,
        lnum: 0,
        body: typeof snip.body === 'string' ? snip.body : snip.body.join(os.EOL),
        prefix: snip.prefix,
        description: snip.description,
        triggerKind: TriggerKind.LineBegin
      }
    },
    )
    return normalizedSnippets
  }
}
