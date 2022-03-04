import { Disposable, Document, Uri, Extension, extensions, OutputChannel, Position, Range, workspace } from 'coc.nvim'
import fs from 'fs'
import { parse, ParseError } from 'jsonc-parser'
import path from 'path'
import BaseProvider from './baseProvider'
import { Snippet, SnippetEdit, TextmateConfig, TriggerKind } from './types'
import { distinct, languageIdFromComments, sameFile } from './util'

export interface ISnippetPluginContribution {
  lnum: number
  scope?: string
  prefix: string | string[]
  body: string | string[]
  description: string | string[]
}

export interface SnippetItem {
  languageIds: string[]
  filepath: string
}

export interface SnippetCache {
  [language: string]: Snippet[]
}

interface KeyToSnippet {
  [key: string]: ISnippetPluginContribution
}

export class TextmateProvider extends BaseProvider {
  private loadedFiles: Set<string> = new Set()
  private loadedSnippets: Snippet[] = []
  private loadedLanguageIds: Set<string> = new Set()
  private definitions: Map<string, SnippetItem[]> = new Map()

  constructor(
    private channel: OutputChannel,
    protected config: TextmateConfig,
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
            items = items.filter(o => o.languageIds.some(id => workspace.languageIds.has(id)))
            this.loadSnippetsFromDefinition(extension.id, items)
          }
        }, e => {
          this.channel.appendLine(`[Error] ${e.message}`)
        })
      }, null, this.subscriptions)
      extensions.onDidUnloadExtension(id => {
        this.loadedSnippets = this.loadedSnippets.filter(item => {
          return item.extensionId !== id
        })
      }, null, this.subscriptions)
    }
    let paths = this.config.snippetsRoots
    for (let dir of paths ?? []) {
      await this.loadDefinitionFromRoot(dir)
    }
    for (let languageId of workspace.languageIds) {
      await this.loadByLanguageId(languageId)
    }
    workspace.onDidOpenTextDocument(e => {
      this.loadByLanguageId(e.languageId)
    }, null, this.subscriptions)
    if (this.config.projectSnippets) {
      workspace.workspaceFolders.forEach(folder => {
        let fsPath = Uri.parse(folder.uri).fsPath
        void this.loadFromWorkspace(fsPath)
      })
      workspace.onDidChangeWorkspaceFolders(e => {
        e.removed.forEach(folder => {
          let fsPath = Uri.parse(folder.uri).fsPath
          this.loadedSnippets = this.loadedSnippets.filter(o => {
            return !o.filepath.startsWith(fsPath + path.sep)
          })
        })
        e.added.forEach(folder => {
          let fsPath = Uri.parse(folder.uri).fsPath
          void this.loadFromWorkspace(fsPath)
        })
      })
    }
  }

  private async loadFromWorkspace(fsPath: string): Promise<void> {
    let root = path.join(fsPath, '.vscode')
    await this.loadDefinitionFromRoot(root)
  }

  private async loadByLanguageId(languageId: string): Promise<void> {
    if (this.loadedLanguageIds.has(languageId)) return
    let filetypes = this.getFiletypes(languageId)
    this.channel.appendLine(`Load textmate snippets from filetypes: ${filetypes.join(', ')}`)
    for (let languageId of filetypes) {
      if (this.loadedLanguageIds.has(languageId)) continue
      this.loadedLanguageIds.add(languageId)
      for (let [extensionId, items] of this.definitions.entries()) {
        for (let item of items) {
          if (!item.languageIds.includes(languageId)) continue
          await this.loadSnippetsFromFile(item.filepath, item.languageIds, extensionId)
        }
      }
    }
  }


  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    let filepaths: string[] = []
    for (let filetype of filetypes) {
      let snippets = this.loadedSnippets.filter(s => s.filetype == filetype)
      if (snippets.length) {
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
        priority: snip.priority ?? -1
      })
    }
    return edits
  }

  public async getSnippets(filetype: string): Promise<Snippet[]> {
    let res: Snippet[] = []
    let filetypes: string[] = this.getFiletypes(filetype)
    filetypes.push('all')
    let added: Set<string> = new Set()
    for (let filetype of filetypes) {
      let snippets = this.loadedSnippets.filter(o => o.filetype == filetype)
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
          arr.push({
            languageIds: languages,
            filepath: p
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
      if (file.endsWith('.code-snippets')) {
        let extensionId = path.basename(root)
        // Don't know languageId, load all of them
        await this.loadSnippetsFromFile(filepath, undefined, extensionId)
      } else {
        let basename = path.basename(file, '.json')
        items.push({ languageIds: [basename], filepath })
      }
    }
    this.definitions.set('user-snippets', items)
  }

  private async loadSnippetsFromDefinition(extensionId: string, items: SnippetItem[]): Promise<void> {
    for (let item of items) {
      if (!fs.existsSync(item.filepath)) continue
      await this.loadSnippetsFromFile(item.filepath, item.languageIds, extensionId)
    }
  }

  private async loadSnippetsFromFile(snippetFilePath: string, languageIds: string[] | undefined, extensionId: string): Promise<void> {
    if (this.isLoaded(snippetFilePath)) return
    if (this.isIgnored(snippetFilePath)) {
      this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] file ignored by excludePatterns: ${snippetFilePath}`)
      return
    }
    let contents: string
    try {
      contents = await fs.promises.readFile(snippetFilePath, 'utf8')
    } catch (e) {
      this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] Error on load "${snippetFilePath}": ${e.message}`)
      return
    }
    this.loadSnippetsFromText(snippetFilePath, extensionId, languageIds, contents)
  }

  private isLoaded(filepath: string): boolean {
    for (let file of this.loadedFiles) {
      if (sameFile(file, filepath)) {
        return true
      }
    }
    return false
  }

  private loadSnippetsFromText(filepath: string, extensionId: string, ids: string[] | undefined, contents: string): void {
    let snippets: ISnippetPluginContribution[] = []
    let defaulLanguageId: string
    try {
      let errors: ParseError[] = []
      let lines = contents.split(/\r?\n/)
      defaulLanguageId = languageIdFromComments(lines)
      let snippetObject = parse(contents, errors, { allowTrailingComma: true }) as KeyToSnippet
      if (errors.length) {
        this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] parser error of ${filepath}: ${JSON.stringify(errors, null, 2)}`)
      }
      if (snippetObject) {
        for (let key of Object.keys(snippetObject)) {
          let p = '"' + key + '"'
          let idx = lines.findIndex(line => line.trim().startsWith(p))
          let lnum = idx == -1 ? 0 : idx
          snippets.push(Object.assign({ lnum }, snippetObject[key]))
        }
      }
    } catch (ex) {
      this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] ${ex.stack}`)
      snippets = []
    }
    this.loadedFiles.add(filepath)
    const normalizedSnippets: Snippet[] = []
    snippets.forEach((snip: ISnippetPluginContribution) => {
      if (!snip.prefix) return
      let languageIds = snip.scope ? snip.scope.split(',') : undefined
      if (!languageIds && defaulLanguageId) languageIds = [defaulLanguageId]
      if (!languageIds && ids) languageIds = ids
      if (!languageIds) languageIds = ['all']
      let prefixs = Array.isArray(snip.prefix) ? snip.prefix : [snip.prefix]
      prefixs.forEach(prefix => {
        for (let filetype of languageIds) {
          normalizedSnippets.push({
            extensionId,
            filepath,
            lnum: snip.lnum,
            filetype,
            body: typeof snip.body === 'string' ? snip.body : snip.body.join('\n'),
            prefix,
            description: typeof snip.description === 'string' ? snip.description : typeof snip.description !== 'undefined' ? snip.description.join('\n') : '',
            triggerKind: TriggerKind.WordBoundary,
            priority: -1
          })
        }
      })
    })
    this.loadedSnippets.push(...normalizedSnippets)
    this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Loaded ${normalizedSnippets.length} textmate snippets from ${filepath}`)
  }
}
