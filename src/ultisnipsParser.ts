/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { exec } from 'child_process'
import { OutputChannel, workspace } from 'coc.nvim'
import fs from 'fs'
import pify from 'pify'
import readline from 'readline'
import Parser from './parser'
import { Snippet, TriggerKind, UltiSnipsFile } from './types'
import { convertRegex, headTail, getRegexText, getTriggerText } from './util'

export default class UltiSnipsParser {
  constructor(private pyMethod: string, private channel?: OutputChannel, private trace = 'error') {
  }

  public parseUltisnipsFile(filetype: string, filepath: string): Promise<Partial<UltiSnipsFile>> {
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
          let body = preLines.join('\n')
          // TODO remove this
          body = body.replace(/((?:[^\\]?\$\{\w+?)\/)([^\n]*?[^\\])(?=\/)/g, (_match, p1, p2) => {
            return p1 + convertRegex(p2)
          })
          let ms = first.match(/^(.+?)(?:\s+(?:"(.*?)")?(?:\s+"(.*?)")?(?:\s+(\w+))?)?\s*$/)
          let trigger = getTriggerText(ms[1])
          let option = ms[4] || ''
          let regex: RegExp = null
          let originRegex: string
          if (option.indexOf('r') !== -1) {
            originRegex = trigger
            let pattern = convertRegex(trigger)
            regex = new RegExp(pattern.endsWith('$') ? pattern : pattern + '$')
            // get the real text
            trigger = getRegexText(trigger)
            option = option + 'i'
          }
          let snippet: Snippet = {
            originRegex,
            context: parsedContext ? parsedContext : (option.includes('e') ? ms[3] : undefined),
            filepath,
            filetype,
            prefix: trigger,
            autoTrigger: option.indexOf('A') !== -1,
            lnum: lnum - preLines.length - 2,
            triggerKind: getTriggerKind(option),
            description: ms[2] || '',
            regex,
            body,
            priority
          }
          snippets.push(snippet)
        } catch (e) {
          this.error(`Create snippet error on: ${filepath}:${lnum - preLines.length - 1} ${e.message}`)
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
        let indent = resolved.split(/\n/).slice(-1)[0].match(/^\s*/)[0]
        resolved = resolved + await this.execute(code, pyMethod, indent)
        continue
      } else if (parser.curr == '$') {
        let text = parser.next(7)
        if (text.startsWith('VISUAL') || text.startsWith('{VISUAL')) {
          parser.eat(8)
          resolved += '$' + text.replace('VISUAL', 'TM_SELECTED_TEXT')
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

  public async execute(code: string, pyMethod: string, indent: string): Promise<string> {
    let { nvim } = workspace
    let res = ''
    if (code.startsWith('!')) {
      code = code.trim().slice(1)
      if (code.startsWith('p')) {
        code = code.slice(1).trim()
        let lines = [
          'import traceback',
          'try:',
          '    snip._reset("")'
        ]
        lines.push(...code.split('\n').map(line => '    ' + line.replace(/\t/g, '    ')))
        lines.push('except Exception as e:')
        lines.push('    snip.rv = traceback.format_exc()')
        await nvim.command(`${pyMethod} ${lines.join('\n')}`)
        res = await nvim.call(`${pyMethod}eval`, 'snip.rv')
      } else if (code.startsWith('v')) {
        code = code.replace(/^v\s*/, '')
        try {
          res = await nvim.eval(code) as any
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
        this.error(`Error on eval ${code}: ` + e.stack)
      }
    }
    res = res.toString()
    res = res.replace(/\r?\n$/, '')
    let parts = res.split(/\r?\n/)
    if (parts.length > 1) {
      res = parts.map((s, idx) => {
        if (idx == 0 || s.length == 0) return s
        return `${indent}${s}`
      }).join('\n')
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
  if (option.indexOf('i') !== -1) {
    return TriggerKind.InWord
  }
  if (option.indexOf('w') !== -1) {
    return TriggerKind.WordBoundary
  }
  if (option.indexOf('b') !== -1) {
    return TriggerKind.LineBegin
  }
  return TriggerKind.SpaceBefore
}
