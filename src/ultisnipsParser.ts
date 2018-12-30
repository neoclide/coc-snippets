/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { workspace, OutputChannel } from 'coc.nvim'
import fs from 'fs'
import readline from 'readline'
import { Snippet, TriggerKind, UltiSnipsFile } from './types'
import { headTail, trimQuote } from './util'
import pify from 'pify'
import { exec } from 'child_process'
import Parser from './parser'

export default class UltiSnipsParser {
  constructor(private channel: OutputChannel, private pyMethod: string) {
  }

  public parseUltisnipsFile(filepath: string): Promise<Partial<UltiSnipsFile>> {
    const rl = readline.createInterface({
      input: fs.createReadStream(filepath, 'utf8'),
      crlfDelay: Infinity
    })
    let pycodes: string[] = []
    let snippets: Snippet[] = []
    let block: string
    let preLines: string[] = []
    let first: string
    let priority = 0
    let lnum = 0
    let extendFiletypes: string[] = []
    rl.on('line', line => {
      line = line.replace(/\s+$/, '')
      const [head, tail] = headTail(line)
      if (head == 'priority' && !block) {
        priority = parseInt(tail.trim())
      } else if (head == 'extends') {
        let fts = tail.trim().split(/,\s+/)
        for (let ft of fts) {
          if (extendFiletypes.indexOf(ft) == -1) {
            extendFiletypes.push(ft)
          }
        }
      } else if (head == 'snippet' || head == 'global') {
        block = head
        first = tail
      } else if (head == 'endglobal' && block == 'global') {
        block = ''
        pycodes.push(...preLines)
        preLines = []
      } else if (head == 'endsnippet' && block == 'snippet') {
        block = ''
        let body = preLines.join('\n')
        let parser = new Parser(first)
        parser.skipSpaces()
        // parse prefix
        let quote = parser.curr == '"'
        let idx = parser.nextIndex(quote ? '"' : ' ', quote)
        let prefix = trimQuote(parser.eatTo(idx + (quote ? 1 : 0)))
        parser.skipSpaces()
        quote = parser.curr == '"'
        // parse description
        let description = ''
        if (quote) {
          let idx = parser.nextIndex('"', true, false)
          if (idx !== -1) description = trimQuote(parser.eatTo(idx + 1))
        }
        parser.skipSpaces()
        let option = parser.next(3)
        preLines = []
        let snippet: Snippet = {
          filepath,
          lnum,
          description,
          prefix,
          triggerKind: getTriggerKind(option),
          expression: option.indexOf('r') !== -1,
          body,
          priority
        }
        snippets.push(snippet)
      } else if (block == 'snippet' || block == 'global') {
        preLines.push(line)
      }
      lnum += 1
    })
    return new Promise(resolve => {
      rl.on('close', async () => {
        resolve({ snippets, pythonCode: pycodes.join('\n'), extendFiletypes })
      })
    })
  }

  public async resolveUltisnipsBody(body: string): Promise<string> {
    let { pyMethod } = this
    let parser = new Parser(body)
    let resolved = ''
    while (!parser.eof()) {
      if (parser.curr == '`') {
        let idx = parser.nextIndex('`', true, false)
        if (idx == -1) {
          resolved = resolved + parser.eatTo(parser.len)
          break
        }
        let code = parser.eatTo(idx + 1)
        code = code.slice(1, -1)
        resolved = resolved + await this.execute(code, pyMethod)
        continue
      } else if (parser.curr == '$') {
        let next = parser.next()
        let text = next == '{' ? parser.next(7).slice(1) : parser.next(6)
        if (text == 'VISUAL') {
          parser.eat(next == '{' ? 8 : 7)
          resolved = resolved + `$${next}TM_SELECTED_TEXT`
        } else {
          // skip current
          let ch = parser.eat(1)
          resolved = resolved + ch
        }
      }
      let prev = parser.prev()
      parser.iterate(ch => {
        if (prev !== '\\' && (ch == '`' || ch == '$')) {
          return false
        } else {
          resolved = resolved + ch
        }
        prev == ch
        return true
      })
    }
    resolved = decode(resolved)
    this.channel.appendLine(`[Debug ${(new Date()).toLocaleTimeString()}] resolved: ${resolved}`)
    return resolved
  }

  private async execute(code: string, pyMethod: string): Promise<string> {
    let { nvim } = workspace
    let res: string = ''
    if (code.startsWith('!')) {
      code = code.trim().slice(1)
      if (code.startsWith('p')) {
        code = code.slice(1).trim()
        let lines = code.split('\n')
        lines = lines.map(line => line.replace(/\t/g, '    '))
        lines = lines.map(line => `    ${line}`)
        lines.unshift('try:')
        lines.unshift('import traceback')
        lines.push('except Exception as e:')
        lines.push('    snip.rv = traceback.format_exc()')
        await nvim.command(`${pyMethod} ${lines.join('\n')}`)
        res = await nvim.call(`${pyMethod}eval`, 'snip.rv')
      } else if (code.startsWith('v')) {
        code = code.replace(/^v\s*/, '')
        try {
          res = await nvim.eval(code) as any
          res = res.toString()
        } catch (e) {
          res = `Error: ${e.message}`
          this.error(e.stack)
        }
      }
    } else {
      try {
        res = await pify(exec)(code)
      } catch (e) {
        res = `Error: ${e.message}`
        workspace.showMessage(`Failed to execute code: ${code}: ${e.message}`, 'error')
        this.error(`Error on eval ${code}: ` + e.stack)
      }
    }
    return res
  }

  private error(str: string): void {
    this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] ${str}`)
  }
}

function decode(str: string): string {
  return str.replace(/\\`/g, '`').replace(/\\{/g, '{')
}

function getTriggerKind(option: string): TriggerKind {
  if (option.indexOf('w') !== -1) {
    return TriggerKind.WordBoundary
  }
  if (option.indexOf('b') !== -1) {
    return TriggerKind.LineBegin
  }
  if (option.indexOf('i') !== -1) {
    return TriggerKind.InWord
  }
  return TriggerKind.WordBoundary
}
