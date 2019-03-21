/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { exec } from 'child_process'
import { OutputChannel } from 'coc.nvim'
import fs from 'fs'
import pify from 'pify'
import readline from 'readline'
import Parser from './parser'
import { Snippet, TriggerKind, UltiSnipsFile } from './types'
import { convertRegex, headTail, getRegexText } from './util'

export default class UltiSnipsParser {
  constructor(private pyMethod: string, private channel?: OutputChannel, private trace = 'error') {
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
    let clearsnippets = null
    let parsedContext = null
    let extendFiletypes: string[] = []
    rl.on('line', line => {
      lnum += 1
      if (!block && (line.startsWith('#') || line.length == 0)) return
      const [head, tail] = headTail(line)
      if (!block) {
        switch (head) {
          case 'priority':
            let n = parseInt(tail.trim(), 10)
            if (!isNaN(n)) priority = n
            break
          case 'extends':
            let fts = tail.trim().split(/,\s+/)
            for (let ft of fts) {
              if (extendFiletypes.indexOf(ft) == -1) {
                extendFiletypes.push(ft)
              }
            }
            break
          case 'clearsnippets':
            clearsnippets = priority
            break
          case 'context':
            parsedContext = tail.replace(/^"(.+)"$/, '$1')
            break
          case 'snippet':
          case 'global':
            block = head
            first = tail
            break
        }
        return
      }
      if (head == 'endglobal' && block == 'global') {
        block = null
        pycodes.push(...preLines)
        preLines = []
        return
      }
      if (head == 'endsnippet' && block == 'snippet') {
        block = null
        try {
          let originRegex: string
          let body = preLines.join('\n')
          // convert placeholder regex to javascript regex
          body = body.replace(/((?:[^\\]?\$\{[^/]+)\/)(.*?[^\\])(?=\/)/g, (_match, p1, p2) => {
            return p1 + convertRegex(p2)
          })
          let ms = first.match(/^(.+?)(?:\s+(?:"(.*?)")?(?:\s+"(.*?)")?(?:\s+(\w+))?)?$/)
          let prefix = ms[1]
          let description = ms[2] || ''
          let context = ms[3]
          let option = ms[4] || ''
          if (prefix.length > 2 && prefix[0] == prefix[prefix.length - 1] && !/\w/.test(prefix[0])) {
            prefix = prefix.slice(1, prefix.length - 1)
          }
          let isExpression = option.indexOf('r') !== -1
          let regex: RegExp = null
          if (isExpression) {
            originRegex = prefix
            prefix = convertRegex(prefix)
            prefix = prefix.endsWith('$') ? prefix : prefix + '$'
            try {
              regex = new RegExp(prefix)
              // get the real text
              prefix = getRegexText(prefix)
            } catch (e) {
              this.error(`Convert regex error for: ${prefix}`)
            }
          }
          if (option.indexOf('e') !== -1) {
            context = context || parsedContext
          } else {
            context = null
          }
          let snippet: Snippet = {
            filepath,
            context,
            originRegex,
            autoTrigger: option.indexOf('A') !== -1,
            lnum: lnum - preLines.length - 2,
            triggerKind: getTriggerKind(option),
            prefix,
            description,
            regex,
            body,
            priority
          }
          snippets.push(snippet)
        } catch (e) {
          this.error(`Create snippet error on: ${filepath}:${lnum - preLines.length - 1}`)
        } finally {
          parsedContext = null
          preLines = []
        }
      }
      if (block == 'snippet' || block == 'global') {
        preLines.push(line)
        return
      }
    })
    return new Promise(resolve => {
      rl.on('close', async () => {
        resolve({ snippets, clearsnippets, pythonCode: pycodes.join('\n'), extendFiletypes })
      })
    })
  }

  public async resolveUltisnipsBody(body: string): Promise<string> {
    let { pyMethod } = this
    let parser = new Parser(body)
    let resolved = ''
    while (!parser.eof()) {
      let p = parser.prev()
      if (parser.curr == '`' && (!p || p != '\\')) {
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
        let text = parser.next(7)
        if (text.startsWith('VISUAL') || text.startsWith('{VISUAL')) {
          parser.eat(8)
          resolved = resolved + '$' + text.replace('VISUAL', 'TM_SELECTED_TEXT')
        } else {
          // skip current
          resolved += parser.eat(1)
        }
      }
      let prev = parser.prev() || ''
      parser.iterate(ch => {
        if (prev !== '\\' && (ch == '`' || ch == '$')) {
          return false
        } else {
          resolved = resolved + ch
        }
        prev = ch
        return true
      })
    }
    resolved = decode(resolved)
    this.debug(`resolved: ${resolved}`)
    return resolved
  }

  private async execute(code: string, pyMethod: string): Promise<string> {
    let { nvim } = require('coc.nvim').workspace
    if (!nvim) return code
    let res = ''
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
        res = res.replace(/\r?\n$/, '')
      } catch (e) {
        res = `Error: ${e.message}`
        this.error(`Error on eval ${code}: ` + e.stack)
      }
    }
    return res
  }

  private error(str: string): void {
    if (!this.channel) return
    this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] ${str}`)
  }

  private debug(str: string): void {
    if (!this.channel || this.trace == 'error') return
    this.channel.appendLine(`[Debug ${(new Date()).toLocaleTimeString()}] ${str}`)
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
  return TriggerKind.SpaceBefore
}
