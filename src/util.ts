/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import pify from 'pify'
import path from 'path'
import os from 'os'
import fs from 'fs'
import { ReplaceItem } from './types'
import crypto from 'crypto'
import { promisify } from 'util'
import { Document, Uri } from 'coc.nvim'

const caseInsensitive = os.platform() == 'win32' || os.platform() == 'darwin'
const BASE64 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_'

function tostr(bytes: Uint8Array): string {
  let r: string[] = []
  let i
  for (i = 0; i < bytes.length; i++) {
    r.push(BASE64[bytes[i] % 64])
  }
  return r.join('')
}

export function uid(): string {
  return tostr(crypto.randomBytes(10))
}

export const documentation = `# A valid snippet should starts with:
#
#		snippet trigger_word [ "description" [ options ] ]
#
# and end with:
#
#		endsnippet
#
# Snippet options:
#
#		b - Beginning of line.
#		i - In-word expansion.
#		w - Word boundary.
#		r - Regular expression
#		e - Custom context snippet
#		A - Snippet will be triggered automatically, when condition matches.
#
# Basic example:
#
#		snippet emitter "emitter properties" b
#		private readonly $\{1} = new Emitter<$2>()
#		public readonly $\{1/^_(.*)/$1/}: Event<$2> = this.$1.event
#		endsnippet
#
# Online reference: https://github.com/SirVer/ultisnips/blob/master/doc/UltiSnips.txt
`


export function replaceText(content: string, items: ReplaceItem[]): string {
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

const stringStartRe = /\\A/
const conditionRe = /\(\?\(\w+\).+\|/
const commentRe = /\(\?#.*?\)/
const namedCaptureRe = /\(\?P<\w+>.*?\)/
const namedReferenceRe = /\(\?P=(\w+)\)/
const regex = new RegExp(`${commentRe.source}|${stringStartRe.source}|${namedCaptureRe.source}|${namedReferenceRe.source}`, 'g')

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
    throw new Error('(?id/name)yes-pattern|no-pattern not supported')
  }
  return str.replace(regex, (match, p1) => {
    if (match.startsWith('(?#')) return ''
    if (match == '\\A') return '^'
    if (match.startsWith('(?P<')) return '(?' + match.slice(3)
    if (match.startsWith('(?P=')) return `\\k<${p1}>`
    return ''
  })
}

export function getRegexText(prefix: string): string {
  if (prefix.startsWith('^')) prefix = prefix.slice(1)
  if (prefix.endsWith('$')) prefix = prefix.slice(0, -1)
  // keep word inside ()?
  let content = prefix.replace(/\((\w+)\)\?/g, '$1').replace(/\(.*\)\??/g, '')
  content = content.replace(/\\/g, '')
  return content
}

export function getTriggerText(text: string, regex: boolean): string {
  if (!text || /\w/.test(text[0]) || text.length <= 2) return text ?? ''
  if (text[0] == text[text.length - 1] && (regex || text.includes(' ') || text[0] == '/')) return text.slice(1, -1)
  return text
}

export function markdownBlock(code: string, filetype: string): string {
  filetype = filetype == 'javascriptreact' ? 'javascript' : filetype
  filetype = filetype == 'typescriptreact' ? 'typescript' : filetype
  return '``` ' + filetype + '\n' + code + '\n```'
}

export async function waitDocument(doc: Document, changedtick: number): Promise<boolean> {
  if (doc.changedtick >= changedtick) return Promise.resolve(doc.changedtick === changedtick)
  return new Promise(resolve => {
    let timeout = setTimeout(() => {
      disposable.dispose()
      resolve(doc.changedtick == changedtick)
    }, 200)
    let disposable = doc.onDocumentChange(() => {
      clearTimeout(timeout)
      disposable.dispose()
      resolve(doc.changedtick == changedtick)
    })
  })
}

export function isParentFolder(folder: string, filepath: string, checkEqual = false): boolean {
  let pdir = fixDriver(path.resolve(path.normalize(folder)))
  let dir = fixDriver(path.resolve(path.normalize(filepath)))
  if (pdir == '//') pdir = '/'
  if (sameFile(pdir, dir)) return checkEqual ? true : false
  if (pdir.endsWith(path.sep)) return fileStartsWith(dir, pdir)
  return fileStartsWith(dir, pdir) && dir[pdir.length] == path.sep
}

// use uppercase for windows driver
export function fixDriver(filepath: string, platform = os.platform()): string {
  if (platform != 'win32' || filepath[1] != ':') return filepath
  return filepath[0].toUpperCase() + filepath.slice(1)
}

export function sameFile(fullpath: string | null, other: string | null): boolean {
  if (!fullpath || !other) return false
  if (caseInsensitive) return fullpath.toLowerCase() === other.toLowerCase()
  return fullpath === other
}

export function fileStartsWith(dir: string, pdir: string) {
  if (caseInsensitive) return dir.toLowerCase().startsWith(pdir.toLowerCase())
  return dir.startsWith(pdir)
}

export function characterIndex(content: string, byteIndex: number): number {
  let buf = Buffer.from(content, 'utf8')
  return buf.slice(0, byteIndex).toString('utf8').length
}

export function languageIdFromComments(lines: string[]): string | undefined {
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    let ms = lines[i].match(/^\s*\/\/\sPlace\syour\s(\w+)\sworkspace/)
    if (ms) return ms[1]
  }
  return undefined
}


export function omit<T>(obj: T, properties: string[]): T {
  let o = {}
  for (let key of Object.keys(obj)) {
    if (!properties.includes(key)) {
      o[key] = obj[key]
    }
  }
  return o as T
}

export function normalizeFilePath(filepath: string) {
  return Uri.file(path.resolve(path.normalize(filepath))).fsPath
}
