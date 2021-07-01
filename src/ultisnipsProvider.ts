import { disposeAll, Document, ExtensionContext, OutputChannel, Uri, window, workspace } from 'coc.nvim'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { Disposable, Position, Range } from 'coc.nvim'
import BaseProvider from './baseProvider'
import { FileItem, Snippet, SnippetEdit, TriggerKind, UltiSnipsConfig, UltiSnipsFile } from './types'
import UltiSnipsParser from './ultisnipsParser'
import { distinct, readdirAsync, readFileAsync, statAsync, uid } from './util'

const pythonCodes: Map<string, string> = new Map()

export class UltiSnippetsProvider extends BaseProvider {
  private snippetFiles: UltiSnipsFile[] = []
  private pyMethod: string
  private disposables: Disposable[] = []
  private directories: string[] = []
  private parser: UltiSnipsParser
  private runtimeDirs: string[] = []
  constructor(
    private channel: OutputChannel,
    private trace: string,
    protected config: UltiSnipsConfig,
    private context: ExtensionContext
  ) {
    super(config)
    this.runtimeDirs = workspace.env.runtimepath.split(',')
    workspace.watchOption('runtimepath', async (_, newValue: string) => {
      let parts = newValue.split(',')
      let subFolders = await this.getSubFolders()
      let items: FileItem[] = []
      for (let dir of parts) {
        if (this.runtimeDirs.indexOf(dir) == -1) {
          this.runtimeDirs.push(dir)
          let res = await this.getSnippetsFromPlugin(dir, subFolders)
          items.push(...res)
        }
      }
      if (items.length) {
        await Promise.all(items.map(({ filepath, directory, filetype }) => {
          return this.loadSnippetsFromFile(filetype, directory, filepath)
        }))
        let files = items.map(o => o.filepath)
        let pythonCode = ''
        for (let file of files) {
          let code = pythonCodes.get(file)
          if (code) {
            pythonCode += `# ${file}\n` + code + '\n'
          }
        }
        if (pythonCode) {
          pythonCodes.clear()
          await this.executePythonCode(pythonCode)
        }
      }
    }, this.disposables)
  }

  public checkLoaded(filepath: string): boolean {
    return this.snippetFiles.findIndex(o => o.filepath == filepath) !== -1
  }

  public async init(): Promise<void> {
    let { nvim, env } = workspace
    let { runtimepath } = env
    let { config } = this
    for (let dir of config.directories) {
      if (dir.startsWith('~') || dir.indexOf('$') !== -1) {
        let res = await workspace.nvim.call('expand', [dir])
        this.directories.push(res)
      } else {
        this.directories.push(dir)
      }
    }
    this.channel.appendLine(`[Info ${(new Date()).toISOString()}] Using ultisnips directories: ${this.directories.join(' ')}`)
    let hasPythonx = await nvim.call('has', ['pythonx'])
    let pythonCode = await readFileAsync(this.context.asAbsolutePath('python/ultisnips.py'), 'utf8')
    if (hasPythonx && config.usePythonx) {
      this.pyMethod = 'pyx'
    } else {
      this.pyMethod = config.pythonVersion == 3 ? 'py3' : 'py'
    }
    this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Using ultisnips python command: ${this.pyMethod}`)
    this.parser = new UltiSnipsParser(this.pyMethod, this.channel, this.trace)
    let arr = await this.getAllSnippetFiles(runtimepath)
    let files = arr.map(o => o.filepath)
    await Promise.all(arr.map(({ filepath, directory, filetype }) => {
      return this.loadSnippetsFromFile(filetype, directory, filepath)
    }))
    for (let file of files) {
      let code = pythonCodes.get(file)
      if (code) {
        pythonCode += `\n# ${file}\n` + code + '\n'
      }
    }
    await this.executePythonCode(pythonCode)
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
    this.channel.appendLine(`[Info ${(new Date()).toISOString()}] Loaded ${snippets.length} UltiSnip snippets from: ${filepath}`)
    pythonCodes.set(filepath, pythonCode)
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
      let re = /\$\{(\d+)(?::([^}]+))?\}/g
      let r
      // tslint:disable-next-line: no-conditional-assignment
      while (r = re.exec(body)) {
        let idx = parseInt(r[1], 10)
        let val: string = r[2] || ''
        let exists = values.get(idx)
        if (exists == null || (val && exists == "''")) {
          if (/^`!\w/.test(val) && val.endsWith('`')) {
            let code = val.slice(1).slice(0, -1)
            // not execute python code since we don't have snip yet.
            if (code.startsWith('!p')) {
              val = ''
            } else {
              val = await this.parser.execute(code, this.pyMethod, ind)
            }
          }
          val = val.replace(/'/g, "\\'").replace(/\n/g, '\\n')
          values.set(idx, "r'" + val + "'")
        }
      }
      re = /\$(\d+)/g
      // tslint:disable-next-line: no-conditional-assignment
      while (r = re.exec(body)) {
        let idx = parseInt(r[1], 10)
        if (!values.has(idx)) {
          values.set(idx, "''")
        }
      }
      let len = values.size == 0 ? 0 : Math.max.apply(null, Array.from(values.keys()))
      let vals = (new Array(len)).fill('""')
      for (let [idx, val] of values.entries()) {
        vals[idx] = val
      }
      let pyCodes: string[] = []
      pyCodes.push('import re, os, vim, string, random')
      pyCodes.push(`t = (${vals.join(',')})`)
      pyCodes.push(`fn = r'${path.basename(filepath)}'`)
      pyCodes.push(`path = r'${filepath}'`)
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

  public async getAllSnippetFiles(runtimepath: string): Promise<FileItem[]> {
    let { directories } = this
    let res: FileItem[] = []
    for (let directory of directories) {
      if (path.isAbsolute(directory)) {
        let items = await this.getSnippetFileItems(directory)
        res.push(...items)
      }
    }
    let subFolders = await this.getSubFolders()
    let rtps = runtimepath.split(',')
    this.runtimeDirs = rtps
    for (let rtp of rtps) {
      let items = await this.getSnippetsFromPlugin(rtp, subFolders)
      res.push(...items)
    }
    return res
  }

  public async getSubFolders(): Promise<string[]> {
    let { directories } = this
    directories = directories.filter(s => !path.isAbsolute(s))
    // use UltiSnipsSnippetDirectories
    let dirs = await workspace.nvim.eval('get(g:, "UltiSnipsSnippetDirectories", [])') as string[]
    for (let dir of dirs) {
      if (directories.indexOf(dir) == -1) {
        directories.push(dir)
      }
    }
    return directories
  }

  private async getSnippetsFromPlugin(directory: string, subFolders: string[]): Promise<FileItem[]> {
    let res: FileItem[] = []
    for (let folder of subFolders) {
      let items = await this.getSnippetFileItems(path.join(directory, folder))
      res.push(...items)
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

  private async executePythonCode(pythonCode: string): Promise<void> {
    try {
      let dir = path.join(os.tmpdir(), `coc.nvim-${process.pid}`)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir)
      let tmpfile = path.join(os.tmpdir(), `coc.nvim-${process.pid}`, `coc-ultisnips-${uid()}.py`)
      fs.writeFileSync(tmpfile, '# -*- coding: utf-8 -*-\n' + pythonCode, 'utf8')
      await workspace.nvim.command(`exe '${this.pyMethod}file '.fnameescape('${tmpfile}')`)
      pythonCodes.clear()
    } catch (e) {
      this.channel.appendLine(`Error on execute python script:`)
      this.channel.append(e.message)
      window.showMessage(`Error on execute python script: ${e.message}`, 'error')
    }
  }

  public dispose(): void {
    disposeAll(this.disposables)
  }
}
