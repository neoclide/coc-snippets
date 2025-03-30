import { commands, Document, ExtensionContext, OutputChannel, Position, Range, TextEdit, Uri, window, workspace, WorkspaceConfiguration } from 'coc.nvim'
import fs from 'fs'
import os from 'os'
import path from 'path'
import util from 'util'
import BaseProvider from './baseProvider'
import { FileItem, Snippet, SnippetEdit, TriggerKind, UltiSnipsConfig, UltiSnipsFile } from './types'
import UltiSnipsParser from './ultisnipsParser'
import { createMD5, distinct, documentation, filetypeFromBasename, getAdditionalFiletype, getAllAdditionalFiletype, pythonCodes, readdirAsync, sameFile, statAsync } from './util'

export class UltiSnippetsProvider extends BaseProvider {
  private loadedLanguageIds: Set<string> = new Set()
  private errorFiles: Set<string> = new Set()
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
        let filetype = filetypeFromBasename(path.basename(filepath, '.snippets'))
        if (this.allFiletypes.includes(filetype)) await this.loadSnippetsFromFile({ filetype, filepath, directory: path.dirname(filepath) })
      }
    }, null, this.context.subscriptions)
  }

  private get directories(): string[] {
    let dirs = this.config.directories || []
    return dirs.map(dir => workspace.expand(dir))
  }

  private async showPrompt(): Promise<void> {
    if (!this.config.pythonPrompt) return
    let name = workspace.isVim ? `python` : `provider-python`
    await window.showWarningMessage(`The Ultisnips feature of coc-snippets requires Python support on Vim, see :h ${name}`, {
      title: 'I understand, don\'t show this message again',
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
      void this.showPrompt()
    }
    this.parser = new UltiSnipsParser(this.channel, this.config.trace)
    this.fileItems = await this.loadAllFileItems(env.runtimepath)
    workspace.onDidRuntimePathChange(async e => {
      let subFolders = await this.getSubFolders()
      const newItems: FileItem[] = []
      for (const dir of e) {
        let res = await this.getFilesFromDirectory(dir, subFolders)
        if (res?.length) newItems.push(...res)
      }
      let items = newItems.filter(item => !this.fileItems.find(o => o.filepath === item.filepath))
      if (items.length) {
        this.fileItems.push(...items)
        let { allFiletypes } = this
        for (let item of items) {
          if (allFiletypes.includes(item.filetype)) {
            await this.loadSnippetsFromFile(item)
          }
        }
      }
    }, null, this.context.subscriptions)
    if (this.pythonSupport) {
      let filepath = this.context.asAbsolutePath('python/ultisnips.py')
      await workspace.nvim.call('coc#util#open_file', ['pyxfile', filepath])
    }
  }

  public async loadSnippetsByFiletype(filetype: string): Promise<void> {
    let filetypes = this.getFiletypes(filetype)
    if (!filetypes.includes('all')) filetypes.push('all')
    filetypes = filetypes.filter(filetype => !this.loadedLanguageIds.has(filetype))
    if (filetypes.length == 0) return
    let sorted = getSortedFiletypes(filetype, filetypes)
    sorted.forEach(filetype => this.loadedLanguageIds.add(filetype))
    for (let ft of sorted) {
      for (let item of this.fileItems) {
        if (item.filetype === ft) {
          await this.loadSnippetsFromFile(item)
        }
      }
    }
  }

  private get allFiletypes(): string[] {
    let filetypes = Array.from(workspace.filetypes).concat(getAllAdditionalFiletype())
    let res: Set<string> = new Set()
    for (let ft of filetypes) {
      let arr = this.getFiletypes(ft)
      arr.forEach(val => res.add(val))
    }
    res.add('all')
    return Array.from(res)
  }

  public async loadSnippetsFromFile(fileItem: FileItem): Promise<void> {
    let { filepath, directory, filetype } = fileItem
    let idx = this.snippetFiles.findIndex(o => sameFile(o.filepath, filepath))
    if (idx !== -1 || this.isIgnored(filepath)) return
    let { snippets, pythonCode, extendFiletypes, clearsnippets } = await this.parser.parseUltisnipsFile(filetype, filepath)
    if (!this.pythonSupport) {
      // filter snippet with python
      snippets = snippets.filter(s => s.regex == null && s.context == null && !s.body.includes('`!p'))
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
      let fts: Set<string> = new Set()
      for (let ft of extendFiletypes) {
        this.getFiletypes(ft).forEach(s => fts.add(s))
      }
      let promises: Promise<void>[] = []
      this.fileItems.forEach(item => {
        if (!fts.has(item.filetype)) return
        promises.push(this.loadSnippetsFromFile(item))
      })
      await Promise.allSettled(promises)
    }
    this.info(`Loaded ${snippets.length} UltiSnip snippets from: ${filepath}`)
    if (pythonCode.trim().length > 0) {
      pythonCodes.set(filepath, { hash: createMD5(pythonCode), code: pythonCode })
      this.executePyCodesForFile(filepath).catch(e => {
        this.error(e.message)
      })
    }
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
    let snippets = this.getDocumentSnippets(document)
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
        actions: s.actions,
        newText: s.body,
        prefix: s.prefix,
        description: s.description,
        location: s.filepath,
        priority: s.priority,
        regex: s.originRegex,
        context: s.context,
        formatOptions: s.formatOptions
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

  public async loadAllFileItems(runtimepath: string): Promise<FileItem[]> {
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

  private async getFiletype(): Promise<string> {
    let buf = await workspace.nvim.buffer
    if (buf) {
      let doc = workspace.getDocument(buf.id)
      if (doc) return doc.filetype
    }
    return null
  }

  public async editSnippets(text?: string): Promise<void> {
    const configuration = workspace.getConfiguration('snippets')
    let filetype = await this.getFiletype()
    filetype = filetype ?? 'all'
    filetype = filetype.indexOf('.') == -1 ? filetype : filetype.split('.')[0]
    const snippetsDir = await getSnippetsDirectory(configuration)
    let { nvim } = workspace
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
        for (let filename of files) {
          let file = path.join(directory, filename)
          if (file.endsWith('.snippets')) {
            let basename = path.basename(filename, '.snippets')
            let filetype = filetypeFromBasename(basename)
            res.push({ filepath: file, directory, filetype })
          } else {
            let stat = await statAsync(file)
            if (stat && stat.isDirectory()) {
              let files = await readdirAsync(file)
              for (let filename of files) {
                if (filename.endsWith('.snippets')) {
                  res.push({ filepath: path.join(file, filename), directory, filetype: filename })
                }
              }
            }
          }
        }
      }
    }
    return res
  }

  public async executePyCodesForFile(filepath: string): Promise<void> {
    let info = pythonCodes.get(filepath)
    if (!info) return
    let { code, hash } = info
    const tmpfile = path.join(os.tmpdir(), `coc-snippets-${hash}.py`)
    try {
      if (this.errorFiles.has(tmpfile)) return
      if (!fs.existsSync(tmpfile)) {
        let prefix = [
          '# -*- coding: utf-8 -*-\n',
          `# ${filepath}\n`
        ]
        fs.writeFileSync(tmpfile, prefix.join('\n') + code, 'utf8')
      }
      this.info(`Execute python file ${tmpfile} from: ${filepath}`)
      await workspace.nvim.call('coc#util#open_file', ['pyxfile', tmpfile])
    } catch (e) {
      this.errorFiles.add(tmpfile)
      this.error(`Error on execute python script ${e.stack}:`, code)
      void window.showErrorMessage(`Error python code from file ${filepath}: ${e.message}`)
    }
  }

  public async onFiletypeChange(bufnr: number, filetype: string): Promise<void> {
    let filetypes = distinct([...getAdditionalFiletype(bufnr), ...this.getFiletypes(filetype)])
    let sorted = getSortedFiletypes(filetype, filetypes)
    let files: string[] = []
    sorted.forEach(ft => {
      this.snippetFiles.forEach(s => {
        if (s.filetype === ft) {
          files.push(s.filepath)
        }
      })
    })
    for (let file of files) {
      await this.executePyCodesForFile(file)
    }
  }
}

// make all first and main filetype last
function getSortedFiletypes(filetype: string, filetypes: string[]): string[] {
  let res: string[] = []
  if (filetypes.includes('all')) res.push('all')
  let mainFiletype = filetype.split('.')[0]
  res.push(...filetypes.filter(s => s !== mainFiletype && s !== 'all'))
  if (mainFiletype.length > 0) res.push(mainFiletype)
  return res
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
      window.showWarningMessage(`snippets.userSnippetsDirectory => ${snippetsDir} should be absolute path`)
      snippetsDir = null
    }
  }
  if (!snippetsDir) snippetsDir = path.join(path.dirname(workspace.env.extensionRoot), 'ultisnips')
  if (!fs.existsSync(snippetsDir)) {
    await fs.promises.mkdir(snippetsDir, { recursive: true })
  }
  return snippetsDir
}
