import { Disposable, Document, Extension, extensions, OutputChannel, Position, Range, Uri, workspace } from 'coc.nvim'
import fs from 'fs'
import { parse, ParseError } from 'jsonc-parser'
import path from 'path'
import BaseProvider from './baseProvider'
import { Snippet, SnippetEdit, TextmateConfig, TriggerKind } from './types'
import { languageIdFromComments, normalizeFilePath, omit, sameFile, statAsync } from './util'

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

export interface SnippetDef {
  readonly filepath: string
  readonly lnum: number
  readonly body: string
  readonly description: string
  readonly triggerKind: TriggerKind
  /**
   * Use prefixes instead of prefix
   */
  readonly prefixes: string[]
  /**
   * Use filetypes instead of filetype
   */
  readonly filetypes: string[]
  readonly priority: number
  extensionId?: string
}

export class TextmateProvider extends BaseProvider {
  private loadedFiles: Set<string> = new Set()
  private loadedSnippets: SnippetDef[] = []
  private loadedLanguageIds: Set<string> = new Set()
  private definitions: Map<string, SnippetItem[]> = new Map()
  private loadedRoots: Set<string> = new Set()

  constructor(
    channel: OutputChannel,
    protected config: TextmateConfig,
    private subscriptions: Disposable[]
  ) {
    super(config, channel)
  }

  public async init(): Promise<void> {
    if (this.config.loadFromExtensions) {
      for (let extension of extensions.all) {
        this.loadSnippetDefinition(extension).then(items => {
          if (items?.length) {
            items = items.filter(o => o.languageIds.includes('all') || o.languageIds.some(id => workspace.languageIds.has(id)))
            this.loadSnippetsFromDefinition(extension.id, items)
          }
        }, e => {
          this.error(`Error on load textmate snippets: ${e.message}`, e.stack)
        })
      }
      extensions.onDidLoadExtension(extension => {
        this.loadSnippetDefinition(extension).then(items => {
          if (items?.length) {
            items = items.filter(o => o.languageIds.includes('all') || o.languageIds.some(id => workspace.languageIds.has(id)))
            this.loadSnippetsFromDefinition(extension.id, items)
          }
        }, e => {
          this.error(`Error on load textmate snippets: ${e.message}`, e.stack)
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
    await this.loadDefinitionFromRoot(root, false)
  }

  public async loadSnippetsByFiletype(languageId: string): Promise<void> {
    if (this.loadedLanguageIds.has(languageId)) return
    let filetypes = this.getFiletypes(languageId)
    this.info(`Loading textmate snippets from filetypes: ${filetypes.join(', ')}`)
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
    filetypes.push('all')
    let filepaths: string[] = []
    for (let def of this.loadedSnippets) {
      if (filepaths.includes(def.filepath)) continue
      if (def.filetypes.some(ft => filetypes.includes(ft))) {
        filepaths.push(def.filepath)
      }
    }
    return filepaths
  }

  public async getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]> {
    if (autoTrigger) return []
    let line = document.getline(position.line)
    line = line.slice(0, position.character)
    let snippets = this.getDocumentSnippets(document)
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

  public getSnippets(filetype: string): Snippet[] {
    let res: Snippet[] = []
    let filetypes: string[] = this.getFiletypes(filetype)
    filetypes.push('all')
    for (let def of this.loadedSnippets) {
      if (filetypes.some(ft => def.filetypes.includes(ft))) {
        let languageId = def.filetypes.includes(filetype) ? filetype : def.filetypes.find(ft => filetypes.includes(ft))
        res.push(...toSnippets(def, languageId))
      }
    }
    res.sort((a, b) => {
      if (a.filetype != b.filetype) {
        if (a.filetype == filetype || b.filetype == filetype) {
          return a.filetype == filetype ? -1 : 1
        }
        if (a.filetype == 'all' || b.filetype == 'all') {
          return a.filetype == 'all' ? 1 : -1
        }
        if (a.priority != b.priority) {
          return b.priority - a.priority
        }
        return 0
      }
    })
    let filtered: Snippet[] = []
    for (let item of res) {
      // consider the same by prefix & description
      if (!filtered.find(o => o.prefix == item.prefix && o.description == item.description)) {
        filtered.push(item)
      }
    }
    // this.info('filtered:', filtered)
    return filtered
  }

  private async loadSnippetDefinition(extension: Extension<any>): Promise<SnippetItem[]> {
    let { packageJSON } = extension
    const arr: SnippetItem[] = []
    if (packageJSON.contributes && packageJSON.contributes.snippets) {
      let { snippets } = packageJSON.contributes
      const extensionId = extension.id
      for (let item of snippets) {
        let p = path.join(extension.extensionPath, item.path)
        let exists = arr.find(o => o.filepath == p)
        let languages: string[] = Array.isArray(item.language) ? item.language : [item.language]
        if (exists) {
          languages.forEach(s => {
            if (!exists.languageIds.includes(s)) {
              exists.languageIds.push(s)
            }
          })
          continue
        }
        if (fs.existsSync(p)) arr.push({ languageIds: languages, filepath: p })
      }
      if (snippets && snippets.length) {
        this.definitions.set(extensionId, arr)
      }
    }
    return arr
  }

  private async loadDefinitionFromRoot(configPath: string, showWarningMessage = true): Promise<void> {
    let root = workspace.expand(configPath)
    let stat = await statAsync(root)
    if (!stat || !stat.isDirectory()) {
      if (showWarningMessage) this.warn(`${configPath} not a valid directory.`)
      return
    }
    root = normalizeFilePath(root)
    if (this.loadedRoots.has(root)) return
    this.loadedRoots.add(root)
    let files = await fs.promises.readdir(root, 'utf8')
    files = files.filter(f => f.endsWith('.json') || f.endsWith('.code-snippets'))
    let items: SnippetItem[] = this.definitions.get('') ?? []
    for (let file of files) {
      let filepath = path.join(root, file)
      if (file.endsWith('.code-snippets')) {
        this.info(`Loading global snippets from: ${filepath}`)
        // Don't know languageId, load all of them
        await this.loadSnippetsFromFile(filepath, undefined, undefined)
      } else {
        let basename = path.basename(file, '.json')
        items.push({ languageIds: [basename], filepath })
      }
    }
    this.definitions.set('', items)
  }

  private async loadSnippetsFromDefinition(extensionId: string, items: SnippetItem[]): Promise<void> {
    for (let item of items) {
      if (!fs.existsSync(item.filepath)) continue
      await this.loadSnippetsFromFile(item.filepath, item.languageIds, extensionId)
    }
  }

  private async loadSnippetsFromFile(snippetFilePath: string, languageIds: string[] | undefined, extensionId: string | undefined): Promise<void> {
    if (this.isLoaded(snippetFilePath) || this.isIgnored(snippetFilePath)) return
    let contents: string
    try {
      contents = await fs.promises.readFile(snippetFilePath, 'utf8')
    } catch (e) {
      this.error(`Error on readFile "${snippetFilePath}": ${e.message}`)
      return
    }
    try {
      this.loadSnippetsFromText(snippetFilePath, extensionId, languageIds, contents)
    } catch (e) {
      this.error(`Error on load snippets from "${snippetFilePath}": ${e.message}`, e.stack)
    }
  }

  private isLoaded(filepath: string): boolean {
    for (let file of this.loadedFiles) {
      if (sameFile(file, filepath)) {
        return true
      }
    }
    return false
  }

  private loadSnippetsFromText(filepath: string, extensionId: string | undefined, ids: string[] | undefined, contents: string): void {
    let snippets: ISnippetPluginContribution[] = []
    let commentLanguageId: string
    let isGlobal = isGlobalSnippet(filepath)
    this.loadedFiles.add(filepath)
    try {
      let errors: ParseError[] = []
      let lines = contents.split(/\r?\n/)
      if (isGlobal) commentLanguageId = languageIdFromComments(lines)
      let snippetObject = parse(contents, errors, { allowTrailingComma: true }) as KeyToSnippet
      if (errors.length) this.error(`Parse error of ${filepath}`, errors)
      if (snippetObject) {
        for (let key of Object.keys(snippetObject)) {
          let p = '"' + key + '"'
          let idx = lines.findIndex(line => line.trim().startsWith(p))
          let lnum = idx == -1 ? 0 : idx
          snippets.push(Object.assign({ lnum }, snippetObject[key]))
        }
      }
    } catch (ex) {
      this.error(`Error on parse "${filepath}": ${ex.message}`, ex.stack)
      return
    }
    const normalizedSnippets: SnippetDef[] = []
    snippets.forEach((snip: ISnippetPluginContribution) => {
      if (!snip.prefix) return
      let languageIds: string[]
      if (ids && ids.length > 0) {
        languageIds = ids
      } else if (isGlobal) {
        languageIds = snip.scope ? snip.scope.split(',') : undefined
        if (!languageIds && commentLanguageId) languageIds = [commentLanguageId]
      }
      if (!languageIds && isGlobal) languageIds = ['all']
      let obj: SnippetDef = {
        prefixes: Array.isArray(snip.prefix) ? snip.prefix : [snip.prefix],
        filetypes: languageIds,
        extensionId,
        filepath,
        lnum: snip.lnum,
        body: typeof snip.body === 'string' ? snip.body : snip.body.join('\n'),
        description: getDescription(snip.description),
        triggerKind: TriggerKind.WordBoundary,
        priority: languageIds.includes('all') ? -60 : extensionId ? -2 : -1
      }
      normalizedSnippets.push(obj)
      this.trace(`Snippet:`, obj)
    })
    this.loadedSnippets.push(...normalizedSnippets)
    this.info(`Loaded ${normalizedSnippets.length} textmate snippets from ${filepath}`, ids)
  }
}

function getDescription(description: unknown): string | undefined {
  if (typeof description === 'string') return description
  if (Array.isArray(description) && description.every(s => typeof s === 'string')) return description.join('\n')
  return undefined
}

function toSnippets(def: SnippetDef, languageId: string): Snippet[] {
  return def.prefixes.map(prefix => {
    return Object.assign(omit<SnippetDef>(def, ['filetypes', 'prefixes']), {
      prefix,
      filetype: languageId,
    })
  })
}

function isGlobalSnippet(filepath: string): boolean {
  return filepath.endsWith('.code-snippets')
}
