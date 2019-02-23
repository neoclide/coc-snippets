/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import pify from 'pify'
import fs from 'fs'
import { ReplaceItem } from './types'

export function replaceText(content: string, items: ReplaceItem[]) {
  let res = ''
  items.sort((a, b) => a.index - b.index)
  let item = items.shift()
  for (let i = 0; i < content.length; i++) {
    let idx = item ? item.index : null
    if (idx == null || i != idx) {
      res = res + content[i]
      continue
    }
    res = res + item.newText
    i = i + item.length
  }
  return res
}

export function flatten<T>(arr: T[][]): T[] {
  return arr.reduce((p, curr) => p.concat(curr), [])
}

export async function statAsync(filepath: string): Promise<fs.Stats> {
  try {
    return await pify(fs.stat)(filepath)
  } catch (e) {
    return null
  }
}

export async function writeFileAsync(fullpath, content: string): Promise<void> {
  await pify(fs.writeFile)(fullpath, content, 'utf8')
}

export async function readFileAsync(fullpath, encoding = 'utf8'): Promise<string> {
  return await pify(fs.readFile)(fullpath, encoding)
}

export async function readdirAsync(filepath: string): Promise<string[]> {
  try {
    return await pify(fs.readdir)(filepath)
  } catch (e) {
    return null
  }
}

export function headTail(line: string): [string, string] | null {
  line = line.trim()
  let ms = line.match(/^(\S+)\s+(.*)/)
  if (!ms) return [line, '']
  return [ms[1], ms[2]]
}

export function memorize<R extends (...args: any[]) => Promise<R>>(_target: any, key: string, descriptor: any): void {
  let fn = descriptor.get
  if (typeof fn !== 'function') return
  let memoKey = '$' + key

  descriptor.get = function(...args): Promise<R> {
    if (this.hasOwnProperty(memoKey)) return Promise.resolve(this[memoKey])
    return new Promise((resolve, reject): void => { // tslint:disable-line
      Promise.resolve(fn.apply(this, args)).then(res => {
        this[memoKey] = res
        resolve(res)
      }, e => {
        reject(e)
      })
    })
  }
}

export function trimQuote(str: string): string {
  if (str.startsWith('"') || str.startsWith("'")) return str.slice(1, -1)
  return str
}

export function distinct<T>(array: T[], keyFn?: (t: T) => string): T[] {
  if (!keyFn) {
    return array.filter((element, position) => {
      return array.indexOf(element) === position
    })
  }
  const seen: { [key: string]: boolean } = Object.create(null)
  return array.filter(elem => {
    const key = keyFn(elem)
    if (seen[key]) {
      return false
    }

    seen[key] = true

    return true
  })
}

const conditionRe = /\(\?\(\?:\w+\).+\|/
const bellRe = /\\a/
const commentRe = /\(\?#.*?\)/
const stringStartRe = /\\A/
const namedCaptureRe = /\(\?P<\w+>.*?\)/
const namedReferenceRe = /\(\?P=(\w+)\)/
const braceRe = /\^\]/
const regex = new RegExp(`${bellRe.source}|${commentRe.source}|${stringStartRe.source}|${namedCaptureRe.source}|${namedReferenceRe.source}|${braceRe}`, 'g')

/**
 * Convert python regex to javascript regex,
 * throw error when unsupported pattern found
 *
 * @public
 * @param {string} str
 * @returns {string}
 */
export function convertRegex(str: string): string {
  if (str.indexOf('\\z') !== -1) {
    throw new Error('pattern \\z not supported')
  }
  if (str.indexOf('(?s)') !== -1) {
    throw new Error('pattern (?s) not supported')
  }
  if (str.indexOf('(?x)') !== -1) {
    throw new Error('pattern (?x) not supported')
  }
  if (str.indexOf('\n') !== -1) {
    throw new Error('multiple line pattern not supported')
  }
  if (conditionRe.test(str)) {
    throw new Error('condition pattern not supported')
  }
  return str.replace(regex, (match, p1) => {
    if (match == '^]') return '^\\]'
    if (match == '\\a') return ''
    if (match.startsWith('(?#')) return ''
    if (match == '\\A') return '^'
    if (match.startsWith('(?P<')) return '(?' + match.slice(3)
    if (match.startsWith('(?P=')) return `\\k<${p1}>`
    return ''
  })
}

export function wait(ms: number): Promise<any> {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

export function getRegexText(prefix: string): string {
  if (prefix.startsWith('^')) prefix = prefix.slice(1)
  let content = ''
  if (prefix.startsWith('(')) {
    let count = 1
    let pre = ''
    for (let i = 0; i < prefix.length; i++) {
      let ch = prefix[i]
      if (ch == '(' && pre != '\\') {
        count = count + 1
      } else if (ch == ')' && pre != '\\') {
        count = count - 1
        if (count == 0) {
          content = prefix.slice(i + 1)
          break
        }
      }
      pre = ch
    }
  } else {
    content = prefix
  }
  if (/\\w/.test(content)) return ''
  if (/(^|[^\\])[+?.{(\[]/.test(content)) return ''
  return content
}
