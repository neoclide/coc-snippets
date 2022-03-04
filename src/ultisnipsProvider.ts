import { Document, ExtensionContext, OutputChannel, Position, Range, Uri, window, workspace } from 'coc.nvim'
import fs from 'fs'
import os from 'os'
import path from 'path'
import BaseProvider from './baseProvider'
import { FileItem, Snippet, SnippetEdit, TriggerKind, UltiSnipsConfig, UltiSnipsFile } from './types'
import UltiSnipsParser from './ultisnipsParser'
import { distinct, readdirAsync, sameFile, statAsync, uid } from './util'

const pythonCodes: Map<string, string> = new Map()

export class UltiSnippetsProvider extends BaseProvider {
  private snippetFiles: UltiSnipsFile[] = []
  private fileItems: FileItem[] = []
  private pyMethod: string
  private parser: UltiSnipsParser
  constructor(
    private channel: OutputChannel,
    private trace: string,
    protected config: UltiSnipsConfig,
    private context: ExtensionContext
  ) {
    super(config)
    workspace.onDidSaveTextDocument(async doc => {
      let uri = Uri.parse(doc.uri)
      if (uri.scheme != 'file' || !doc.uri.endsWith('.snippets')) return
      let filepath = uri.fsPath
      if (!fs.existsSync(filepath)) return
      let idx = this.snippetFiles.findIndex(s => sameFile(s.filepath, filepath))
      if (idx !== -1) {
        const snippetFile = this.snippetFiles[idx]
        this.snippetFiles.splice(idx, 1)
        await this.loadSnippetsFromFile({ filetype: snippetFile.filetype, filepath, directory: snippetFile.directory })
      } else {
        // TODO filetype could be wrong
        let filetype = filetypeFromBasename(path.basename(filepath, '.snippets'))
        await this.loadSnippetsFromFile({ filetype, filepath, directory: path.dirname(filepath) })
      }
    }, null, this.context.subscriptions)
  }

  private get directories(): string[] {
    let dirs = this.config.directories || []
    return dirs.map(dir => workspace.expand(dir))
  }

  public async init(): Promise<void> {
    let { nvim, env } = workspace
    let { config } = this
    this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Using ultisnips directories: ${this.directories.join(' ')}`)
    let hasPythonx = await nvim.call('has', ['pythonx'])
    if (hasPythonx && config.usePythonx) {
      this.pyMethod = 'pyx'
    } else {
      this.pyMethod = config.pythonVersion == 3 ? 'py3' : 'py'
    }
    this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Using ultisnips python command: ${this.pyMethod}`)
    this.parser = new UltiSnipsParser(this.pyMethod, this.channel, this.trace)
    this.fileItems = await this.loadAllFilItems(env.runtimepath)
    workspace.onDidRuntimePathChange(async e => {
      let subFolders = await this.getSubFolders()
      const newItems: FileItem[] = []
      for (const dir of e) {
        let res = await this.getSnippetsFromPlugin(dir, subFolders)
        if (res?.length) newItems.push(...res)
      }
      if (newItems.length) {
        this.fileItems.push(...newItems)
        const items = this.getValidItems(newItems)
        if (items.length) await this.loadFromItems(items)
      }
    }, null, this.context.subscriptions)
    let filepath = this.context.asAbsolutePath('python/ultisnips.py')
    await workspace.nvim.command(`exe '${this.pyMethod}file '.fnameescape('${filepath}')`)
    const items = this.getValidItems(this.fileItems)
    if (items.length) await this.loadFromItems(items)
    workspace.onDidOpenTextDocument(async e => {
      let doc = workspace.getDocument(e.bufnr)
      if (doc) await this.loadByFiletype(doc.filetype)
    }, null, this.context.subscriptions)
  }

  private async loadByFiletype(filetype: string): Promise<void> {
    let items = this.getFileItems(filetype)
    if (items.length) await this.loadFromItems(items)
  }

  private getFileItems(filetype: string): FileItem[] {
    let filetypes = this.getFiletypes(filetype)
    filetypes.push('all')
    return this.fileItems.filter(o => filetypes.includes(o.filetype))
  }

  private get allFiletypes(): string[] {
    let filetypes = Array.from(workspace.filetypes)
    let res: string[] = []
    for (let ft of filetypes) {
      let arr = this.getFiletypes(ft)
      arr.forEach(val => {
        if (!res.includes(val)) res.push(val)
      })
    }
    res.push('all')
    return res
  }

  // valid items for current filetypes
  private getValidItems(fileItems: FileItem[]): FileItem[] {
    let filetypes = this.allFiletypes
    return fileItems.filter(o => filetypes.includes(o.filetype))
  }

  private async loadFromItems(items: FileItem[]): Promise<void> {
    if (items.length) {
      await Promise.all(items.map(item => {
        return this.loadSnippetsFromFile(item)
      }))
      let pythonCode = ''
      for (let [file, code] of pythonCodes.entries()) {
        if (code) pythonCode += `# ${file}\n` + code + '\n'
      }
      if (pythonCode) {
        pythonCodes.clear()
        await this.executePythonCode(pythonCode)
      }
    }
  }

  public async loadSnippetsFromFile(fileItem: FileItem): Promise<void> {
    let { filepath, directory, filetype } = fileItem
    let idx = this.snippetFiles.findIndex(o => sameFile(o.filepath, filepath))
    if (idx !== -1) return
    if (this.isIgnored(filepath)) {
      this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] file ignored by excludePatterns: ${filepath}`)
      this.snippetFiles.push({
        extendFiletypes: [],
        directory,
        filepath,
        filetype,
        snippets: []
      })
      return
    }
    idx = this.fileItems.findIndex(o => o.filepath == filepath)
    if (idx !== -1) this.fileItems.splice(idx, 1)
    let { snippets, pythonCode, extendFiletypes, clearsnippets } = await this.parser.parseUltisnipsFile(filetype, filepath)
    this.snippetFiles.push({
      extendFiletypes,
      clearsnippets,
      directory,
      filepath,
      filetype,
      snippets
    })
    if (extendFiletypes?.length) {
      let filetypes = this.config.extends[filetype] || []
      filetypes = filetypes.concat(extendFiletypes)
      this.config.extends[filetype] = distinct(filetypes)
      let fts: string[] = []
      for (let ft of extendFiletypes) {
        let filetypes = this.getFiletypes(ft)
        filetypes.forEach(s => {
          if (!fts.includes(s)) fts.push(s)
        })
      }
      let items = this.fileItems.filter(o => fts.includes(o.filetype))
      await Promise.all(items.map(item => {
        return this.loadSnippetsFromFile(item)
      }))
    }
    this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Loaded ${snippets.length} UltiSnip snippets from: ${filepath}`)
    if (pythonCode) pythonCodes.set(filepath, pythonCode)
  }

  public async resolveSnippetBody(snippet: Snippet, range: Range, line: string): Promise<string> {
    let { nvim } = workspace
    let { body, context, originRegex } = snippet
    let indentCount = await nvim.call('indent', '.') as number
    let ind = ' '.repeat(indentCount)
    // values of each placeholder
    let values: Map<number, string> = new Map()
    let re = /\$\{(\d+)(?::([^}]+))?\}/g
    let ms
    while (ms = re.exec(body)) {
      let idx = parseInt(ms[1], 10)
      let val = ms[2] ?? ''
      let exists = values.get(idx)
      if (exists == null || (val && exists == "''")) {
        if (/^`!\w/.test(val) && val.endsWith('`')) {
          let code = val.slice(1).slice(0, -1)
          // not execute python code since we don't have snip yet.
          if (code.startsWith('p')) {
            val = ''
          } else {
            val = await this.parser.execute(code, this.pyMethod, ind)
          }
        }
        val = val.replace(/\\/g, '').replace(/'/g, "\\'").replace(/\n/g, '\\n')
        values.set(idx, "r'" + val + "'")
      }
    }
    re = /\$(\d+)/g
    // tslint:disable-next-line: no-conditional-assignment
    while (ms = re.exec(body)) {
      let idx = parseInt(ms[1], 10)
      if (!values.has(idx)) {
        values.set(idx, "''")
      }
    }
    let len = values.size == 0 ? 0 : Math.max.apply(null, Array.from(values.keys()))
    let vals = (new Array(len)).fill('""')
    for (let [idx, val] of values.entries()) {
      vals[idx] = val
    }
    let pyCodes: string[] = [
      'import re, os, vim, string, random',
      `t = (${vals.join(',')})`,
      `fn = vim.eval('expand("%:t")') or ""`,
      `path = vim.eval('expand("%:p")') or ""`
    ]
    if (context) {
      pyCodes.push(`snip = ContextSnippet()`)
      pyCodes.push(`context = ${context}`)
    } else {
      pyCodes.push(`context = True`)
    }
    let start = `(${range.start.line},${Buffer.byteLength(line.slice(0, range.start.character))})`
    let end = `(${range.end.line},${Buffer.byteLength(line.slice(0, range.end.character))})`
    pyCodes.push(`snip = SnippetUtil('${ind}', ${start}, ${end}, context)`)
    if (originRegex) {
      pyCodes.push(`pattern = re.compile(r"${originRegex.replace(/"/g, '\\"')}")`)
      pyCodes.push(`match = pattern.search("${line.replace(/"/g, '\\"')}")`)
    }
    await this.executePyCodes(pyCodes)
    let res = await this.parser.resolveUltisnipsBody(body)
    return res
  }

  public async checkContext(context: string): Promise<any> {
    let pyCodes: string[] = [
      'import re, os, vim, string, random',
      'snip = ContextSnippet()',
      `context = ${context}`
    ]
    await this.executePyCodes(pyCodes)
    return await workspace.nvim.call(`${this.pyMethod}eval`, 'True if context else False')
  }

  private async executePyCodes(lines: string[]): Promise<void> {
    await workspace.nvim.command(`${this.pyMethod} ${addPythonTryCatch(lines.join('\n'))}`)
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
      if (s.context) break
    }
    return edits
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    let res: string[] = []
    for (let s of this.snippetFiles) {
      if (filetypes.includes(s.filetype)) {
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

  public async loadAllFilItems(runtimepath: string): Promise<FileItem[]> {
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
            let filetype = filetypeFromBasename(basename)
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
      let code = addPythonTryCatch(pythonCode)
      fs.writeFileSync(tmpfile, '# -*- coding: utf-8 -*-\n' + code, 'utf8')
      this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Execute python code in: ${tmpfile}`)
      await workspace.nvim.command(`exe '${this.pyMethod}file '.fnameescape('${tmpfile}')`)
    } catch (e) {
      this.channel.appendLine(`Error on execute python script:`)
      this.channel.append(e.message)
      window.showMessage(`Error on execute python script: ${e.message}`, 'error')
    }
  }
}

function filetypeFromBasename(basename: string): string {
  if (basename == 'typescript_react') return 'typescriptreact'
  if (basename == 'javascript_react') return 'javascriptreact'
  return basename.split('-', 2)[0]
}

/**
  * vim8 doesn't throw any python error with :py command
  * we have to use g:errmsg since v:errmsg can't be changed in python script.
  */
function addPythonTryCatch(code: string): string {
  if (!workspace.isVim) return code
  let lines = [
    'import traceback, vim',
    `vim.vars['errmsg'] = ''`,
    'try:',
  ]
  lines.push(...code.split('\n').map(line => '    ' + line))
  lines.push('except Exception as e:')
  lines.push(`    vim.vars['errmsg'] = traceback.format_exc()`)
  return lines.join('\n')
}
