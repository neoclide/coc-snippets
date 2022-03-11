/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { OutputChannel } from 'coc.nvim'
import fs from 'fs'
import readline from 'readline'
import { Snippet, TriggerKind, UltiSnipsFile } from './types'
import { convertRegex, getRegexText, getTriggerText, headTail } from './util'

function fixFiletype(filetype: string): string {
  if (filetype === 'javascript_react') return 'javascriptreact'
  return filetype
}

export default class UltiSnipsParser {
  constructor(
    private channel?: OutputChannel,
    private trace = false) {
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
              ft = fixFiletype(ft)
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
          this.debug(`Loaded snippet: ${JSON.stringify(snippet, null, 2)}`)
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

  private error(str: string): void {
    if (!this.channel) return
    this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] ${str}`)
  }

  private debug(str: string): void {
    if (!this.channel || !this.trace) return
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
