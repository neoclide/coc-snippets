/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { Document, Disposable, OutputChannel, Position, Uri, Range, workspace } from 'coc.nvim'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import BaseProvider from './baseProvider'
import Parser from './parser'
import { FileItem, SnipmateConfig, SnipmateFile, Snippet, SnippetEdit, TriggerKind } from './types'
import { readdirAsync, statAsync } from './util'

export class SnipmateProvider extends BaseProvider {
  private fileItems: FileItem[] = []
  private snippetFiles: SnipmateFile[] = []
  private loadedFiletypes: string[] = []
  constructor(
    private channel: OutputChannel,
    config: SnipmateConfig,
    private subscriptions: Disposable[]
  ) {
    super(config)
    workspace.onDidSaveTextDocument(async doc => {
      let uri = Uri.parse(doc.uri)
      if (uri.scheme != 'file') return
      let filepath = uri.fsPath
      if (!fs.existsSync(filepath)) return
      let idx = this.snippetFiles.findIndex(s => s.filepath == filepath)
      if (idx !== -1) {
        let filetype = this.snippetFiles[idx].filetype
        this.snippetFiles.splice(idx, 1)
        await this.loadSnippetsFromFile(filetype, filepath)
      }
    }, null, this.subscriptions)
  }

  public async init(): Promise<void> {
    let { nvim } = workspace
    let author = await nvim.getVar('snips_author')
    if (!author) await nvim.setVar('snips_author', this.config.author)
    this.fileItems = await this.loadAllSnippetFiles()
    workspace.onDidRuntimePathChange(async e => {
      for (let rtp of e) {
        let items = await this.getSnippetFileItems(path.join(rtp, 'snippets'))
        if (items?.length) {
          this.fileItems.push(...items)
          for (let item of items) {
            if (workspace.filetypes.has(item.filetype)) {
              this.loadSnippetsFromFile(item.filetype, item.filepath)
            }
          }
        }
      }
    }, null, this.subscriptions)
    await Promise.all(Array.from(workspace.filetypes).map(filetype => {
      return this.loadByFiletype(filetype)
    }))
    this.loadedFiletypes = Array.from(workspace.filetypes)
    workspace.onDidOpenTextDocument(async e => {
      let doc = workspace.getDocument(e.bufnr)
      if (!this.loadedFiletypes.includes(doc.filetype)) {
        await this.loadByFiletype(doc.filetype)
      }
    }, null, this.subscriptions)
  }

  private async loadByFiletype(filetype: string): Promise<void> {
    let filetypes = filetype ? this.getFiletypes(filetype) : []
    filetypes.push('_')
    for (let item of this.fileItems) {
      if (!filetypes.includes(item.filetype)) continue
      this.loadSnippetsFromFile(item.filetype, item.filepath)
    }
    filetypes.forEach(filetype => {
      if (!this.loadedFiletypes.includes(filetype)) {
        this.loadedFiletypes.push(filetype)
      }
    })
  }


  public async loadSnippetsFromFile(filetype: string, filepath: string): Promise<void> {
    let idx = this.snippetFiles.findIndex(o => o.filepath == filepath)
    if (idx !== -1) return
    let snippets = await this.parseSnippetsFile(filepath)
    this.snippetFiles.push({ filepath, filetype, snippets })
    this.channel.appendLine(`[Info ${(new Date()).toISOString()}] Loaded ${snippets.length} ${filetype} snipmate snippets from: ${filepath}`)
  }

  /**
   * Resolve snippet body to inserted text.
   *
   * @public
   * @param {Snippet} snippet
   * @param {Range} _range
   * @param {string} _line
   * @returns {Promise<string>}
   */
  public async resolveSnippetBody(snippet: Snippet, _range: Range, _line: string): Promise<string> {
    let parser = new Parser(snippet.body)
    let resolved = ''
    let { nvim } = workspace
    while (!parser.eof()) {
      if (parser.curr == '`') {
        let idx = parser.nextIndex('`', true, false)
        if (idx == -1) {
          resolved = resolved + parser.eatTo(parser.len)
          break
        }
        let code = parser.eatTo(idx + 1)
        code = code.slice(1, -1)
        if (code.startsWith('Filename')) {
          resolved = resolved + await nvim.call('expand', '%:p:t')
        } else {
          try {
            resolved = resolved + await nvim.eval(code)
          } catch (e) {
            this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] Error on eval: ${code}`)
          }
        }
        continue
      }
      parser.iterate(ch => {
        if (ch == '`') {
          return false
        } else {
          resolved = resolved + ch
        }
        return true
      })
    }
    return resolved
  }

  /**
   * Parse snippets from snippets file.
   *
   * @public
   * @param {string} filepath
   * @returns {Promise<Snippet[]>}
   */
  public parseSnippetsFile(filepath: string): Promise<Snippet[]> {
    let res: Snippet[] = []
    const rl = readline.createInterface({
      input: fs.createReadStream(filepath, 'utf8'),
      crlfDelay: Infinity
    })
    let lnum = 0
    let lines: string[] = []
    let prefix = ''
    let description = ''
    rl.on('line', line => {
      lnum += 1
      if (line.startsWith('#')) return
      if (line.startsWith('snippet')) {
        line = line.replace(/\s*$/, '')
        if (lines.length && prefix) {
          res.push({
            filepath,
            lnum: lnum - lines.length - 1,
            body: lines.join('\n').replace(/\s+$/, ''),
            prefix,
            description,
            triggerKind: TriggerKind.SpaceBefore
          })
          lines = []
        }
        let ms = line.match(/^snippet\s+(\S+)(?:\s(.+))?$/)
        if (!ms) {
          prefix = ''
          this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] Broken line on ${filepath}:${lnum}`)
          return
        }
        prefix = ms[1]
        description = ms[2] || ''
        return
      }
      if (prefix) {
        if (line.indexOf('VISUAL') !== -1) {
          line = line.replace(/\$(\{?)VISUAL\b(:[^\}])?(\}?)/g, '$$$1TM_SELECTED_TEXT$2$3')
        }
        if (line.startsWith('\t')) {
          lines.push(line.slice(1))
        } else {
          lines.push(line)
        }
      }
    })
    return new Promise(resolve => {
      rl.on('close', async () => {
        if (lines.length) {
          res.push({
            filepath,
            lnum: lnum - lines.length - 1,
            body: lines.join('\n'),
            prefix,
            description,
            triggerKind: TriggerKind.SpaceBefore
          })
        }
        resolve(res)
      })
    })
  }

  public async getTriggerSnippets(document: Document, position: Position, autoTrigger: boolean): Promise<SnippetEdit[]> {
    if (autoTrigger) return []
    let snippets = await this.getSnippets(document.filetype)
    let line = document.getline(position.line)
    line = line.slice(0, position.character)
    if (!line || line[line.length - 1] == ' ') return []
    snippets = snippets.filter(s => {
      let { prefix } = s
      if (!line.endsWith(prefix)) return false
      let pre = line.slice(0, line.length - prefix.length)
      return pre.length == 0 || /\s/.test(pre[pre.length - 1])
    })
    let edits: SnippetEdit[] = []
    for (let s of snippets) {
      let character = position.character - s.prefix.length
      let range = Range.create(position.line, character, position.line, position.character)
      let newText = await this.resolveSnippetBody(s, range, line)
      edits.push({
        prefix: s.prefix,
        description: s.description,
        location: s.filepath,
        range,
        newText,
        priority: -1
      })
    }
    return edits
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes: string[] = filetype ? this.getFiletypes(filetype) : []
    filetypes.push('_')
    let res: string[] = []
    for (let s of this.snippetFiles) {
      if (filetypes.indexOf(s.filetype) !== -1) {
        res.push(s.filepath)
      }
    }
    return res
  }

  public async getSnippets(filetype: string): Promise<Snippet[]> {
    let filetypes: string[] = this.getFiletypes(filetype)
    let snippetFiles = this.snippetFiles.filter(o => o.filetype == '_' || filetypes.indexOf(o.filetype) !== -1)
    let result: Snippet[] = []
    snippetFiles.sort((a, b) => {
      if (a.filetype == b.filetype) return 1
      if (a.filetype == filetype) return -1
      return 1
    })
    for (let file of snippetFiles) {
      let { snippets } = file
      for (let snip of snippets) {
        result.push(snip)
      }
    }
    return result
  }

  private async loadAllSnippetFiles(): Promise<FileItem[]> {
    let { env } = workspace
    let rtps = env.runtimepath.split(',')
    let res: FileItem[] = []
    for (let rtp of rtps) {
      let items = await this.getSnippetFileItems(path.join(rtp, 'snippets'))
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
            let filetype = basename.split('-', 2)[0]
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
