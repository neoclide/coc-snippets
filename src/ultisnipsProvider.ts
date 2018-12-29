/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { Document, OutputChannel, workspace } from 'coc.nvim'
import os from 'os'
import path from 'path'
import { Disposable } from 'vscode-jsonrpc'
import { CompletionItem, Position, Range } from 'vscode-languageserver-types'
import Uri from 'vscode-uri'
import { FileItem, GlobalContext, Provider, Snippet, SnippetEdit, TriggerKind, UltiSnipsConfig, UltiSnipsFile } from './types'
import UltiSnipsParser from './ultisnipsParser'
import { readdirAsync, readFileAsync, statAsync, writeFileAsync } from './util'

export class UltiSnippetsProvider implements Provider {
  private snippetFiles: UltiSnipsFile[] = []
  private pythonVersion: number
  private pythonCode: string
  private pyMethod: string
  private disposables: Disposable[] = []
  private directories: string[]
  private parser: UltiSnipsParser
  constructor(private config: UltiSnipsConfig, private channel: OutputChannel) {
    this.pythonVersion = config.pythonVersion || 3
    this.directories = this.config.directories.map(s => {
      return s.startsWith('~') ? os.homedir() + s.slice(1) : s
    })

    workspace.onDidSaveTextDocument(async doc => {
      let filepath = Uri.parse(doc.uri).fsPath
      if (this.filenames.indexOf(filepath) != -1) {
        let snippetFile = this.snippetFiles.find(s => s.filepath == filepath)
        await this.loadSnippetsFromFile(snippetFile.filetype, snippetFile.directory, filepath)
      }
    }, null, this.disposables)
  }

  private get filenames(): string[] {
    return this.snippetFiles.map(o => o.filepath)
  }

  public async init(): Promise<void> {
    let { pythonVersion } = this
    this.pythonCode = await readFileAsync(path.join(__dirname, '../python/ultisnips.py'), 'utf8')
    if (workspace.isVim) {
      this.pyMethod = 'pyx'
    } else {
      this.pyMethod = pythonVersion == 3 ? 'py3' : 'py'
    }
    this.parser = new UltiSnipsParser(this.channel, this.pyMethod)
    let arr = await this.getAllSnippetFiles()
    await Promise.all(arr.map(({ filepath, directory, filetype }) => {
      return this.loadSnippetsFromFile(filetype, directory, filepath)
    }))
    if (this.pythonCode && this.pyMethod) {
      let { nvim } = workspace
      let tmpfile = path.join(os.tmpdir(), 'coc-ultisnips.py')
      await writeFileAsync(tmpfile, this.pythonCode)
      let escaped = await nvim.call('fnameescape', tmpfile)
      workspace.nvim.command(`${this.pyMethod}file ${escaped}`, true)
    }
  }

  public async loadSnippetsFromFile(filetype: string, directory: string, filepath: string): Promise<void> {
    let { snippets, pythonCode } = await this.parser.parseUltisnipsFile(filepath)
    let idx = this.snippetFiles.findIndex(o => o.filepath == filepath)
    if (idx !== -1) this.snippetFiles.splice(idx, 1)
    this.snippetFiles.push({
      directory,
      filepath,
      filetype,
      snippets
    })
    this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Loaded ${snippets.length} snippets from: ${filepath}`)
    this.pythonCode = this.pythonCode + '\n' + pythonCode
  }

  public async resolveSnippetBody(item: CompletionItem, context: GlobalContext): Promise<string> {
    let { body } = item.data
    let textEdit = item.textEdit!
    let { start } = textEdit.range
    let { filepath, visualText } = context
    visualText = visualText || ''
    if (body.indexOf('`!p') !== -1) {
      let values: Map<number, string> = new Map()
      body.replace(/\$\{(\d+):([^}]+)\}/, (_, p1, p2) => {
        if (p1 == 0) return ''
        values.set(Number(p1), p2)
      })
      let indexes = Array.from(values.keys())
      indexes.sort((a, b) => a - b)
      let vals = indexes.map(idx => values.get(idx))
      vals = vals.map(s => `'${s.replace(/'/g, "\\'")}'`)
      let pyCode = `context = {}
t = ('', ${vals.join(',')})
fn = '${path.basename(filepath)}'
path = '${filepath}'
snip = SnippetUtil('', '','${visualText.replace(/'/g, "\\'")}', (${start.line + 1}, ${start.character + 1}), (${start.line + 1}, ${start.character + 1})) `
      workspace.nvim.command(`${this.pyMethod} ${pyCode}`, true)
    }
    return this.parser.resolveUltisnipsBody(body)
  }

  public async getTriggerSnippets(document: Document, position: Position): Promise<SnippetEdit[]> {
    let { filetype } = document
    let snippets = this.getSnippets(filetype)
    let line = document.getline(position.line)
    line = line.slice(0, position.character)
    if (!line || line[line.length - 1] == ' ') return []
    snippets = snippets.filter(s => {
      if (s.triggerKind == TriggerKind.Auto) return false
      let { prefix } = s
      if (!line.endsWith(prefix)) return false
      if (s.triggerKind == TriggerKind.InWord) return true
      let pre = line.slice(0, line.length - prefix.length)
      if (s.triggerKind == TriggerKind.LineBegin) {
        return pre.trim() == ''
      }
      if (s.triggerKind == TriggerKind.WordBoundary) {
        return pre.length == 0 || !document.isWord(pre[pre.length - 1])
      }
    })
    let edits: SnippetEdit[] = snippets.map(s => {
      let character = position.character - s.prefix.length
      return {
        prefix: s.prefix,
        description: s.description,
        location: s.filepath,
        range: Range.create(position.line, character, position.line, position.character),
        newText: s.body,
      }
    })
    return edits
  }

  public getSnippetFiles(filetype: string): string[] {
    let filetypes: Set<string> = new Set()
    for (let ft of filetype.split('.')) {
      filetypes.add(ft)
    }
    for (const s of filetypes) {
      for (let ft of this.config.extends[s] || []) {
        filetypes.add(ft)
      }
    }
    let res: string[] = []
    for (let s of this.snippetFiles) {
      if (filetypes.has(s.filetype)) {
        res.push(s.filepath)
      }
    }
    return res
  }

  public getSnippets(filetype: string): Snippet[] {
    let snippetsMap: Map<string, Snippet> = new Map()
    let filetypes: Set<string> = new Set()
    for (let ft of filetype.split('.')) {
      filetypes.add(ft)
    }
    for (const s of filetypes) {
      for (let ft of this.config.extends[s] || []) {
        filetypes.add(ft)
      }
    }
    filetypes.add('all')
    let snippetFiles = this.snippetFiles
    for (let filetype of filetypes) {
      let files = snippetFiles.filter(o => o.filetype == filetype)
      for (let { snippets } of files) {
        for (let snip of snippets) {
          let exists = snippetsMap.get(snip.prefix)
          if (!exists || snip.priority > exists.priority) {
            snippetsMap.set(snip.prefix, snip)
          }
        }
      }
    }
    return Array.from(snippetsMap.values())
  }

  public async getAllSnippetFiles(): Promise<FileItem[]> {
    let { nvim } = workspace
    let { directories } = this
    let res: FileItem[] = []
    let opt = await nvim.eval('&rtp') as string
    let rtps = opt.split(',')
    let folders: string[] = []
    for (let directory of directories) {
      if (path.isAbsolute(directory)) {
        let items = await this.getSnippetFileItems(directory)
        res.push(...items)
      } else {
        folders.push(directory)
      }
    }
    if (folders.length) {
      for (let rtp of rtps) {
        for (let directory of folders) {
          let items = await this.getSnippetFileItems(path.join(rtp, directory))
          res.push(...items)
        }
      }
    }
    return res
  }

  private async getSnippetFileItems(directory: string): Promise<FileItem[]> {
    let res: FileItem[] = []
    let stat = await statAsync(directory)
    if (stat && stat.isDirectory()) {
      let files = await readdirAsync(directory)
      if (files.length) {
        for (let f of files) {
          let file = path.join(directory, f)
          if (file.endsWith('.snippets')) {
            let basename = path.basename(f, '.snippets')
            let [filetype] = basename.split('_', 2)
            res.push({ filepath: file, directory, filetype })
          } else {
            let stat = await statAsync(file)
            if (stat && stat.isDirectory()) {
              let files = await readdirAsync(file)
              for (let filename of files) {
                if (filename.endsWith('.snippets')) {
                  res.push({ filepath: path.join(file, filename), directory, filetype: f })
                }
              }
            }
          }
        }
      }
    }
    return res
  }
}
