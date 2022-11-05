import { commands, Document, ExtensionContext, OutputChannel, Position, Range, Uri, window, workspace, TextEdit, WorkspaceConfiguration } from 'coc.nvim'
import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'
import BaseProvider from './baseProvider'
import { FileItem, Snippet, SnippetEdit, TriggerKind, UltiSnipsConfig, UltiSnipsFile } from './types'
import UltiSnipsParser from './ultisnipsParser'
import { distinct, documentation, readdirAsync, sameFile, statAsync, uid } from './util'

const pythonCodes: Map<string, string> = new Map()

export class UltiSnippetsProvider extends BaseProvider {
  private snippetFiles: UltiSnipsFile[] = []
  private fileItems: FileItem[] = []
  private parser: UltiSnipsParser
  private pythonSupport = true
  constructor(
    channel: OutputChannel,
    protected config: UltiSnipsConfig,
    private context: ExtensionContext
  ) {
    super(config, channel)
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

  private async showPrompt(): Promise<void> {
    let name = workspace.isVim ? `python` : `provider-python`
    await window.showWarningMessage(`Ultisnips feature of coc-snippets requires python support on vim, check out :h ${name}`, {
      title: 'Understand, do\'not show again',
      isCloseAffordance: true
    })
    let config = workspace.getConfiguration('snippets.ultisnips', null)
    config.update('pythonPrompt', false, true)
  }

  public async init(): Promise<void> {
    let { nvim, env } = workspace
    this.info(`Using ultisnips directories:`, this.directories)
    try {
      await nvim.call('pyxeval', ['1'])
    } catch (e) {
      this.pythonSupport = false
      if (this.config.pythonPrompt) {
        void this.showPrompt()
      }
    }
    this.parser = new UltiSnipsParser(this.channel, this.config.trace)
    this.fileItems = await this.loadAllFilItems(env.runtimepath)
    workspace.onDidRuntimePathChange(async e => {
      let subFolders = await this.getSubFolders()
      const newItems: FileItem[] = []
      for (const dir of e) {
        let res = await this.getFilesFromDirectory(dir, subFolders)
        if (res?.length) newItems.push(...res)
      }
      if (newItems.length) {
        this.fileItems.push(...newItems)
        const items = this.getValidItems(newItems)
        if (items.length) await this.loadFromItems(items)
      }
    }, null, this.context.subscriptions)
    if (this.pythonSupport) {
      let filepath = this.context.asAbsolutePath('python/ultisnips.py')
      await workspace.nvim.command(`exe 'pyxfile '.fnameescape('${filepath}')`)
    }
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
    if (this.isIgnored(filepath)) return
    idx = this.fileItems.findIndex(o => o.filepath == filepath)
    if (idx !== -1) this.fileItems.splice(idx, 1)
    let { snippets, pythonCode, extendFiletypes, clearsnippets } = await this.parser.parseUltisnipsFile(filetype, filepath)
    if (!this.pythonSupport) {
      // filter snippet with python
      snippets = snippets.filter(s => s.regex == null && s.context == null && s.body.indexOf('`!p') === -1)
    }
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
    this.info(`Loaded ${snippets.length} UltiSnip snippets from: ${filepath}`)
    if (pythonCode) pythonCodes.set(filepath, pythonCode)
  }

  public async checkContext(context: string): Promise<any> {
    if (!this.pythonSupport) return false
    let pyCodes: string[] = [
      'import re, os, vim, string, random',
      'if "snip" in globals():',
      '  __snip = snip',
      'snip = ContextSnippet()',
      `context = ${context}`,
      'if "__snip" in globals():',
      '  snip = __snip',
    ]
    await this.executePyCodes(pyCodes)
    return await workspace.nvim.call(`pyxeval`, 'True if context else False')
  }

  private async executePyCodes(lines: string[]): Promise<void> {
    try {
      await workspace.nvim.command(`pyx ${addPythonTryCatch(lines.join('\n'))}`)
    } catch (e) {
      let err = new Error(e.message)
      err.stack = `Error on execute python code:\n${lines}\n` + e.stack
      throw err
    }
  }

  public async getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]> {
    let snippets = this.getSnippets(document.filetype)
    let line = document.getline(position.line)
    line = line.slice(0, position.character)
    if (line.length == 0) return []
    snippets = snippets.filter(s => {
      if (autoTrigger && !s.autoTrigger) return false
      let match = getMatched(s, line)
      if (match == null) return false
      if (s.triggerKind == TriggerKind.InWord) return true
      let pre = line.slice(0, line.length - match.length)
      if (s.triggerKind == TriggerKind.LineBegin) return pre.trim() == ''
      if (s.triggerKind == TriggerKind.SpaceBefore) return pre.length == 0 || /\s$/.test(pre)
      if (s.triggerKind == TriggerKind.WordBoundary) return pre.length == 0 || !document.isWord(pre[pre.length - 1])
      return false
    })
    snippets.sort((a, b) => {
      if (a.context && !b.context) return -1
      if (b.context && !a.context) return 1
      return 0
    })
    let edits: SnippetEdit[] = []
    let hasContext = false
    for (let s of snippets) {
      let character: number
      if (s.context) {
        let valid = await this.checkContext(s.context)
        if (!valid) continue
        hasContext = true
      } else if (hasContext) {
        break
      }
      if (s.regex == null) {
        character = position.character - s.prefix.length
      } else {
        let len = line.match(s.regex)[0].length
        character = position.character - len
      }
      let range = Range.create(position.line, character, position.line, position.character)
      edits.push({
        range,
        newText: s.body,
        prefix: s.prefix,
        description: s.description,
        location: s.filepath,
        priority: s.priority,
        regex: s.originRegex,
        context: s.context,
      })
    }
    return edits
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    filetypes.push('all')
    let res: string[] = []
    for (let s of this.snippetFiles) {
      if (filetypes.includes(s.filetype)) {
        res.push(s.filepath)
      }
    }
    return res
  }

  public getSnippets(filetype: string): Snippet[] {
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
      let items = await this.getFilesFromDirectory(rtp, subFolders)
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

  public async editSnippets(text?: string): Promise<void> {
    const configuration = workspace.getConfiguration('snippets')
    const snippetsDir = await getSnippetsDirectory(configuration)
    let { nvim } = workspace
    let buf = await nvim.buffer
    let doc = workspace.getDocument(buf.id)
    if (!doc) {
      window.showMessage('Document not found', 'error')
      return
    }
    let filetype = doc.filetype ? doc.filetype : 'all'
    filetype = filetype.indexOf('.') == -1 ? filetype : filetype.split('.')[0]
    let file = path.join(snippetsDir, `${filetype}.snippets`)
    if (!fs.existsSync(file)) {
      await util.promisify(fs.writeFile)(file, documentation, 'utf8')
    }
    let uri = Uri.file(file).toString()
    await workspace.jumpTo(uri, null, configuration.get<string>('editSnippetsCommand'))
    if (text) {
      await nvim.command('normal! G')
      await nvim.command('normal! 2o')
      let position = await window.getCursorPosition()
      let indent = text.match(/^\s*/)[0]
      text = text.split(/\r?\n/).map(s => s.startsWith(indent) ? s.slice(indent.length) : s).join('\n')
      let escaped = text.replace(/([$}\]])/g, '\\$1')
      // tslint:disable-next-line: no-invalid-template-strings
      let snippet = 'snippet ${1:Tab_trigger} "${2:Description}" ${3:b}\n' + escaped + '\nendsnippet'
      let edit = TextEdit.insert(position, snippet)
      await commands.executeCommand('editor.action.insertSnippet', edit, false)
    }
  }

  private async getFilesFromDirectory(directory: string, subFolders: string[]): Promise<FileItem[]> {
    let res: FileItem[] = []
    for (let folder of subFolders) {
      let items = await this.getSnippetFileItems(path.join(directory, folder))
      res.push(...items)
    }
    return res
  }

  /**
   * Get files in directory.
   */
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
    if (!this.pythonSupport) return
    try {
      let tmpfile = path.join(os.tmpdir(), `coc-ultisnips-${uid()}.py`)
      let code = addPythonTryCatch(pythonCode)
      fs.writeFileSync(tmpfile, '# -*- coding: utf-8 -*-\n' + code, 'utf8')
      this.info(`Execute python code in: ${tmpfile}`)
      await workspace.nvim.command(`exe 'pyxfile '.fnameescape('${tmpfile}')`)
    } catch (e) {
      this.error(`Error on execute python script ${e.stack}:`, pythonCode)
      window.showMessage(`Error on execute python script: ${e.message}`, 'error')
    }
  }
}

function filetypeFromBasename(basename: string): string {
  if (basename == 'typescript_react') return 'typescriptreact'
  if (basename == 'javascript_react') return 'javascriptreact'
  if (basename.includes('_')) return basename.split('_', 2)[0]
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

function getMatched(snippet: Snippet, line: string): string | undefined {
  let { prefix, regex } = snippet
  if (regex) {
    let ms = line.match(regex)
    if (!ms) return undefined
    return ms[0]
  }
  if (!line.endsWith(prefix)) return undefined
  return prefix
}

/*
 * Get user snippets directory.
 */
export async function getSnippetsDirectory(configuration: WorkspaceConfiguration): Promise<string> {
  let snippetsDir = configuration.get<string>('userSnippetsDirectory')
  if (snippetsDir) {
    snippetsDir = workspace.expand(snippetsDir)
    if (!path.isAbsolute(snippetsDir)) {
      window.showMessage(`snippets.userSnippetsDirectory => ${snippetsDir} should be absolute path`, 'warning')
      snippetsDir = null
    }
  }
  if (!snippetsDir) snippetsDir = path.join(path.dirname(workspace.env.extensionRoot), 'ultisnips')
  if (!fs.existsSync(snippetsDir)) {
    await fs.promises.mkdir(snippetsDir)
  }
  return snippetsDir
}
