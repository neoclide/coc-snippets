/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { disposeAll, Document, OutputChannel, Uri, Watchman, workspace } from 'coc.nvim'
import { FileChange } from 'coc.nvim/lib/watchman'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Disposable } from 'vscode-jsonrpc'
import { Position, Range } from 'vscode-languageserver-types'
import BaseProvider from './baseProvider'
import { FileItem, Snippet, SnippetEdit, TriggerKind, UltiSnipsConfig, UltiSnipsFile } from './types'
import UltiSnipsParser from './ultisnipsParser'
import { distinct, readdirAsync, readFileAsync, statAsync } from './util'

export class UltiSnippetsProvider extends BaseProvider {
  private snippetFiles: UltiSnipsFile[] = []
  private pythonCodes: Map<string, string> = new Map()
  private pyMethod: string
  private disposables: Disposable[] = []
  private directories: string[]
  private parser: UltiSnipsParser
  constructor(private channel: OutputChannel, private trace: string, protected config: UltiSnipsConfig) {
    super(config)
    this.directories = this.config.directories.map(s => {
      return s.startsWith('~') ? os.homedir() + s.slice(1) : s
    })
  }

  public async init(): Promise<void> {
    let { config, directories } = this
    let hasPythonx = await workspace.nvim.call('has', ['pythonx'])
    let pythonCode = await readFileAsync(path.join(__dirname, '../python/ultisnips.py'), 'utf8')
    if (hasPythonx && config.usePythonx) {
      this.pyMethod = 'pyx'
    } else {
      this.pyMethod = config.pythonVersion == 3 ? 'py3' : 'py'
    }
    this.parser = new UltiSnipsParser(this.pyMethod, this.channel, this.trace)
    let arr = await this.getAllSnippetFiles()
    await Promise.all(arr.map(({ filepath, directory, filetype }) => {
      return this.loadSnippetsFromFile(filetype, directory, filepath)
    }))
    let pythonPaths = Array.from(this.pythonCodes.keys())
    pythonPaths.sort()
    pythonCode += '\n' + pythonPaths.map(p => this.pythonCodes.get(p)).join('\n')
    if (pythonCode) {
      let { nvim } = workspace
      let hash = crypto.createHash('md5').update(pythonCode).digest('hex')
      let tmpfile = path.join(os.tmpdir(), 'coc.nvim', `coc-ultisnips-${hash}.py`)
      if (!fs.existsSync(tmpfile)) {
        fs.writeFileSync(tmpfile, pythonCode, 'utf8')
      }
      let escaped = await nvim.call('fnameescape', tmpfile)
      workspace.nvim.command(`${this.pyMethod}file ${escaped}`, true)
    }
    let watchmanPath = workspace.getWatchmanPath()
    if (!watchmanPath) {
      workspace.onDidSaveTextDocument(async doc => {
        let uri = Uri.parse(doc.uri)
        if (uri.scheme != 'file' || !doc.uri.endsWith('.snippets')) return
        let filepath = uri.fsPath
        if (!fs.existsSync(filepath)) return
        let snippetFile = this.snippetFiles.find(s => s.filepath == filepath)
        if (snippetFile) {
          await this.loadSnippetsFromFile(snippetFile.filetype, snippetFile.directory, filepath)
        } else {
          let filetype = path.basename(filepath, '.snippets')
          await this.loadSnippetsFromFile(filetype, path.dirname(filepath), filepath)
        }
      }, null, this.disposables)
    } else {
      for (let dir of directories) {
        if (!path.isAbsolute(dir)) continue
        let watchman = new Watchman(watchmanPath, this.channel)
        await watchman.watchProject(dir)
        let disposable = await watchman.subscribe('**/*.snippets', async (change: FileChange) => {
          let { files } = change
          files = files.filter(f => f.type == 'f')
          for (let fileItem of files) {
            let filepath = path.join(dir, fileItem.name)
            if (!fileItem.exists) {
              let idx = this.snippetFiles.findIndex(o => o.filepath == filepath)
              if (idx !== -1) this.snippetFiles.splice(idx, 1)
            } else {
              let snippetFile = this.snippetFiles.find(s => s.filepath == filepath)
              if (snippetFile) {
                await this.loadSnippetsFromFile(snippetFile.filetype, snippetFile.directory, filepath)
              } else {
                let filetype = path.basename(filepath, '.snippets')
                await this.loadSnippetsFromFile(filetype, path.dirname(filepath), filepath)
              }
            }
          }
        })
        this.disposables.push(disposable)
      }
    }
  }

  public async loadSnippetsFromFile(filetype: string, directory: string, filepath: string): Promise<void> {
    let { snippets, pythonCode, extendFiletypes, clearsnippets } = await this.parser.parseUltisnipsFile(filepath)
    let idx = this.snippetFiles.findIndex(o => o.filepath == filepath)
    if (idx !== -1) this.snippetFiles.splice(idx, 1)
    this.snippetFiles.push({
      extendFiletypes,
      clearsnippets,
      directory,
      filepath,
      filetype,
      snippets
    })
    if (extendFiletypes) {
      let filetypes = this.config.extends[filetype] || []
      filetypes = filetypes.concat(extendFiletypes)
      this.config.extends[filetype] = distinct(filetypes)
    }
    if (this.trace == 'verbose') {
      this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Loaded ${snippets.length} snippets from: ${filepath}`)
    }
    this.pythonCodes.set(filepath, pythonCode)
  }

  public async resolveSnippetBody(snippet: Snippet, range: Range, line: string): Promise<string> {
    let { nvim } = workspace
    let { body, context, originRegex } = snippet
    let buf = await nvim.buffer
    let filepath = await buf.name
    let indentCount = await nvim.call('indent', '.') as number
    let ind = ' '.repeat(indentCount)
    if (body.indexOf('`!p') !== -1) {
      let values: Map<number, string> = new Map()
      body.replace(/\$\{(\d+):([^}]+)\}/g, (_, p1, p2) => {
        if (p1 == 0) return ''
        values.set(Number(p1), p2)
      })
      let indexes = Array.from(values.keys())
      indexes.sort((a, b) => a - b)
      let vals = indexes.map(idx => values.get(idx))
      vals = vals.map(s => {
        if (/^`!\w/.test(s)) return "''"
        return `'${s.replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
      })
      let pyCodes: string[] = []
      pyCodes.push('import re, os, vim, string, random')
      pyCodes.push(`t = ('', ${vals.join(',')})`)
      pyCodes.push(`fn = '${path.basename(filepath)}'`)
      pyCodes.push(`path = '${filepath}'`)
      if (context) {
        pyCodes.push(`snip = ContextSnippet()`)
        pyCodes.push(`context = ${context}`)
      } else {
        pyCodes.push(`context = {}`)
      }
      let start = `(${range.start.line},${Buffer.byteLength(line.slice(0, range.start.character))})`
      let end = `(${range.end.line},${Buffer.byteLength(line.slice(0, range.end.character))})`
      pyCodes.push(`snip = SnippetUtil('${ind}', ${start}, ${end}, context)`)
      if (originRegex) {
        pyCodes.push(`pattern = re.compile(r"${originRegex.replace(/"/g, '\\"')}")`)
        pyCodes.push(`match = pattern.search("${line.replace(/"/g, '\\"')}")`)
      }
      try {
        await nvim.command(`${this.pyMethod} ${pyCodes.join('\n')}`)
      } catch (e) {
        this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}]: ${e.message}`)
        this.channel.appendLine(`code: ${pyCodes.join('\n')}`)
      }
    }
    return this.parser.resolveUltisnipsBody(body)
  }

  public async checkContext(context: string): Promise<any> {
    let { nvim } = workspace
    let pyCodes: string[] = []
    pyCodes.push('import re, os, vim, string, random')
    pyCodes.push(`snip = ContextSnippet()`)
    pyCodes.push(`context = ${context}`)
    await nvim.command(`${this.pyMethod} ${pyCodes.join('\n')}`)
    let res = await nvim.call(`${this.pyMethod}eval`, 'True if context else False')
    return res
  }

  public async getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]> {
    let snippets = await this.getSnippets(document.filetype)
    let line = document.getline(position.line)
    line = line.slice(0, position.character)
    if (!line || line[line.length - 1] == ' ') return []
    snippets = snippets.filter(s => {
      let { prefix, regex } = s
      if (autoTrigger && !s.autoTrigger) return false
      if (regex) {
        let ms = line.match(regex)
        if (!ms) return false
        prefix = ms[0]
      }
      if (!line.endsWith(prefix)) return false
      if (s.triggerKind == TriggerKind.InWord) return true
      let pre = line.slice(0, line.length - prefix.length)
      if (s.triggerKind == TriggerKind.LineBegin) return pre.trim() == ''
      if (s.triggerKind == TriggerKind.SpaceBefore) return pre.length == 0 || /\s/.test(pre[pre.length - 1])
      if (s.triggerKind == TriggerKind.WordBoundary) return pre.length == 0 || !document.isWord(pre[pre.length - 1])
      return false
    })
    snippets.sort((a, b) => {
      if (a.context && !b.context) return -1
      if (b.context && !a.context) return 1
      return 0
    })
    let edits: SnippetEdit[] = []
    let contextPrefixes: string[] = []
    for (let s of snippets) {
      let character: number
      if (s.context) {
        let valid = await this.checkContext(s.context)
        if (!valid) continue
        contextPrefixes.push(s.context)
      } else if (contextPrefixes.indexOf(s.prefix) !== -1) {
        continue
      }
      if (s.regex == null) {
        character = position.character - s.prefix.length
      } else {
        let len = line.match(s.regex)[0].length
        character = position.character - len
      }
      let range = Range.create(position.line, character, position.line, position.character)
      let newText = await this.resolveSnippetBody(s, range, line)
      edits.push({
        prefix: s.prefix,
        description: s.description,
        location: s.filepath,
        priority: s.priority,
        range,
        newText,
      })
    }
    return edits
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    let res: string[] = []
    for (let s of this.snippetFiles) {
      if (filetypes.indexOf(s.filetype) !== -1) {
        res.push(s.filepath)
      }
    }
    return res
  }

  public async getSnippets(filetype: string): Promise<Snippet[]> {
    let filetypes = this.getFiletypes(filetype)
    filetypes.push('all')
    let snippetFiles = this.snippetFiles.filter(o => filetypes.indexOf(o.filetype) !== -1)
    let min: number = null
    let result: Snippet[] = []
    snippetFiles.sort((a, b) => {
      if (a.filetype == b.filetype) return 1
      if (a.filetype == filetype) return -1
      return 1
    })
    for (let file of snippetFiles) {
      let { snippets, clearsnippets } = file
      if (typeof clearsnippets == 'number') {
        min = min ? Math.max(min, clearsnippets) : clearsnippets
      }
      for (let snip of snippets) {
        if (snip.regex || snip.context) {
          result.push(snip)
        } else {
          let idx = result.findIndex(o => o.prefix == snip.prefix && o.triggerKind == snip.triggerKind)
          if (idx == -1) {
            result.push(snip)
          } else {
            let item = result[idx]
            if (snip.priority > item.priority) {
              result[idx] = item
            }
          }
        }
      }
    }
    if (min != null) result = result.filter(o => o.priority >= min)
    result.sort((a, b) => {
      if (a.context && !b.context) return -1
      if (b.context && !a.context) return 1
      return 0
    })
    return result
  }

  public async getAllSnippetFiles(): Promise<FileItem[]> {
    let { nvim } = workspace
    let { directories } = this
    let res: FileItem[] = []
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
      let opt = await nvim.eval('&rtp') as string
      let rtps = opt.split(',')
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
            let filetype = basename.split('_', 2)[0]
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

  public dispose(): void {
    disposeAll(this.disposables)
  }
}
