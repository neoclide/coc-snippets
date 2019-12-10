/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { Uri, Document, OutputChannel, workspace } from 'coc.nvim'
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { Disposable } from 'vscode-jsonrpc'
import { Position, Range } from 'vscode-languageserver-types'
import BaseProvider from './baseProvider'
import { FileItem, SnipmateConfig, SnipmateFile, Snippet, SnippetEdit, TriggerKind } from './types'
import { readdirAsync, statAsync } from './util'
import Parser from './parser'

export class SnipmateProvider extends BaseProvider {
  private snippetFiles: SnipmateFile[] = []
  private disposables: Disposable[] = []
  constructor(private channel: OutputChannel, private trace: string, config: SnipmateConfig) {
    super(config)
    workspace.onDidSaveTextDocument(async doc => {
      let uri = Uri.parse(doc.uri)
      if (uri.scheme != 'file') return
      let filepath = uri.fsPath
      if (!fs.existsSync(filepath)) return
      let snippetFile = this.snippetFiles.find(s => s.filepath == filepath)
      if (snippetFile) await this.loadSnippetsFromFile(snippetFile.filetype, snippetFile.directory, filepath)
    }, null, this.disposables)
  }

  public async init(): Promise<void> {
    let arr = await this.getAllSnippetFiles()
    let { nvim } = workspace
    let author = await nvim.getVar('snips_author')
    if (!author) await nvim.setVar('snips_author', this.config.author)
    await Promise.all(arr.map(({ filepath, directory, filetype }) => {
      return this.loadSnippetsFromFile(filetype, directory, filepath)
    }))
  }

  public async loadSnippetsFromFile(filetype: string, directory: string, filepath: string): Promise<void> {
    let snippets = await this.parseSnippetsFile(filepath)
    let idx = this.snippetFiles.findIndex(o => o.filepath == filepath)
    if (idx !== -1) this.snippetFiles.splice(idx, 1)
    this.snippetFiles.push({
      directory,
      filepath,
      filetype,
      snippets
    })
    if (this.trace == 'verbose') {
      this.channel.appendLine(`[Info ${(new Date()).toLocaleTimeString()}] Loaded ${snippets.length} snippets from: ${filepath}`)
    }
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
          line = line.replace(/\$\{?VISUAL\b\}?/g, '$TM_SELECTED_TEXT')
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
    let filetypes: string[] = this.getFiletypes(filetype)
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
    filetypes.push('_')
    let snippetFiles = this.snippetFiles.filter(o => filetypes.indexOf(o.filetype) !== -1)
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

  public async getAllSnippetFiles(): Promise<FileItem[]> {
    let { nvim } = workspace
    let opt = await nvim.eval('&rtp') as string
    let rtps = opt.split(',')
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
