/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { OutputChannel } from 'coc.nvim'
import fs from 'fs'
import readline from 'readline'
import { Snippet, TriggerKind, UltiSnipsFile } from './types'
import { convertRegex, getRegexText, getTriggerText, headTail, trimQuote } from './util'

function fixFiletype(filetype: string): string {
  if (filetype === 'javascript_react') return 'javascriptreact'
  return filetype
}

const actionMap = {
  'pre_expand': 'preExpand',
  'post_expand': 'postExpand',
  'post_jump': 'postJump'
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
    let actions: string[] = []
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
          case 'pre_expand':
          case 'post_expand':
          case 'post_jump':
            actions.push(line)
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
        pycodes.push(`# ${lnum - preLines.length}`, ...preLines)
        preLines = []
        return
      }
      if (head == 'endsnippet' && block == 'snippet') {
        block = null
        try {
          let body = preLines.join('\n')
          let ms = first.match(/^(.+?)(?:\s+(?:"(.*?)")?(?:\s+"(.*?)")?(?:\s+(\w+))?)?\s*$/)
          let description = ms[2] || '';
          let option = ms[4] || ''
          let trigger = getTriggerText(ms[1], option.includes('r'))
          let regex: RegExp = null
          let originRegex: string
          let triggers: string[] = []
          if (option.indexOf('r') !== -1) {
            originRegex = trigger
            let pattern = convertRegex(trigger)
            if (pattern.endsWith('$')) pattern = pattern.slice(0, -1)
            regex = new RegExp(`(?:${pattern})$`)
            // get the real text
            let parsed = getRegexText(trigger)
            if (!parsed.includes('|')) {
              triggers.push(parsed)
            } else {
              // parse to words
              triggers = parsed.split(/\|/)
            }
          } else {
            triggers.push(trigger)
          }
          for (let prefix of triggers) {
            let ms = prefix.match(/^\W+/)
            let snippet: Snippet = {
              originRegex,
              context: parsedContext ? parsedContext : (option.includes('e') ? ms[3] : undefined),
              filepath,
              filetype,
              prefix: prefix,
              special: ms == null ? undefined : ms[0],
              autoTrigger: option.indexOf('A') !== -1,
              lnum: lnum - preLines.length - 2,
              triggerKind: getTriggerKind(option),
              description,
              regex,
              body,
              priority,
              actions: {},
              formatOptions: {
                noExpand: option.includes('t'),
                trimTrailingWhitespace: option.includes('m'),
                removeWhiteSpace: option.includes('s')
              }
            }
            while (actions.length) {
              const line = actions.pop()
              const [head, tail] = headTail(line)
              let key = actionMap[head]
              if (key) {
                snippet.actions[key] = trimQuote(tail)
              } else {
                this.error(`Unknown UltiSnips action: ${head}`)
              }
            }
            this.debug(`Loaded snippet`, snippet)
            snippets.push(snippet)
          }
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

  private debug(str: string, data: any): void {
    if (!this.channel || !this.trace) return
    this.channel.appendLine(`[Debug ${(new Date()).toLocaleTimeString()}] ${str}: ${JSON.stringify(data, null, 2)}`)
  }
}

function getTriggerKind(option: string): TriggerKind {
  if (option.indexOf('i') !== -1 || option === 'r') {
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
