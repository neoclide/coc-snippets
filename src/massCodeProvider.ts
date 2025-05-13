import { Document, OutputChannel, Position, Range, window, workspace } from 'coc.nvim'
import http from 'http'

import type { MassCodeConfig, Snippet, SnippetEdit } from './types'
import { TriggerKind } from './types'

import BaseProvider from './baseProvider'

interface SnippetContent {
  label: string
  language: string
  value: string
}

interface HttpConfig {
  headers?: Record<string, string | number>
  host: string
  port: number
  path?: string
  method: 'GET' | 'POST'
}

interface HttpError {
  code: string
}

interface HttpResponseItem {
  isDeleted: boolean
  isFavorites: boolean
  folderId: string
  description?: string
  name: string
  content: SnippetContent[]
  id: string
  createdAt: number
  updatedAt: number
}

type OnEnd = (resolve: (...args: any) => void, reject: (...args: any) => void, body: any) => void

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

const unknownFileTypes = ['typescriptreact', 'javascriptreact']

export class MassCodeProvider extends BaseProvider {
  private massCodeItems: HttpResponseItem[] = []
  private baseHttpConfig: HttpConfig

  constructor(channel: OutputChannel, protected config: MassCodeConfig) {
    super(config, channel)
  }

  public async init(): Promise<void> {
    this.baseHttpConfig = { host: this.config.host, port: this.config.port, method: 'GET' }
    this.massCodeItems = await this.loadAllSnippets()
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let filetypes = this.getFiletypes(filetype)
    filetypes.push('all')
    let res: string[] = []
    for (let s of this.massCodeItems) {
      for (let c of s.content) {
        if (filetypes.includes(c.language)) {
          res.push(s.folderId)
        }
      }
    }
    return res
  }

  public async getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]> {
    if (autoTrigger) return []
    const line = document.getline(position.line)
    if (line.length == 0) return []
    const snippets = this.getDocumentSnippets(document).filter(s => {
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
        newText: s.body,
        prefix: s.prefix,
        description: s.description,
        location: s.filepath,
        lnum: s.lnum,
        priority: s.priority,
        regex: s.originRegex,
        context: s.context,
      })
    }
    return edits
  }

  private async loadAllSnippets(): Promise<HttpResponseItem[]> {
    this.info(`Loading all massCode snippets from http://${this.config.host}:${this.config.port}/snippets/embed-folder`)
    const options: HttpConfig = {
      ...this.baseHttpConfig,
      path: '/snippets/embed-folder',
    }

    const onEnd: OnEnd = (resolve, reject, body) => {
      try {
        resolve(JSON.parse(Buffer.concat(body).toString()))
      } catch (e) {
        reject(e)
      }
    }

    return promisifyHttpRequest<HttpResponseItem[]>(options, onEnd)
  }

  private mapItems(): Snippet[] {
    let counter = 0
    return this.massCodeItems.filter(item => !item.isDeleted).flatMap((item) => {
      return item.content.map(content => {
        const snippet = {
          filepath: item.id,
          lnum: counter,
          body: content.value,
          prefix: item.name,
          description: item.name,
          triggerKind: TriggerKind.WordBoundary,
          filetype: content.language,
        }

        counter = counter + 1

        return snippet
      })
    })
  }

  public getSnippets(filetype: string): Snippet[] {
    return this.mapItems().filter(snippet => this.getFiletypes(filetype).includes(snippet.filetype))
  }

  public async createSnippet(text?: string): Promise<void> {
    const doc = await workspace.document
    const name = await window.requestInput('Snippet Name')

    if (!name) {
      return Promise.resolve()
    }

    // Reinitialize the snippets to see if we saved one with the same name in a previous attempt
    await this.init()

    const filetypes = this.getFiletypes(doc.filetype).filter(filetype => {
      return !unknownFileTypes.includes(filetype)
    })

    if (this.mapItems().some(item => item.prefix === name && filetypes.includes(item.filetype))) {
      window.showWarningMessage(`Snippet with name ${name} for this filetype already exists`)
      return Promise.resolve()
    }

    const config: HttpConfig = {
      ...this.baseHttpConfig,
      method: 'POST',
      path: '/snippets/create'
    }

    const onEnd: OnEnd = (resolve, reject, body) => {
      try {
        resolve(body)
      } catch (e) {
        reject(e)
      }
    }

    const requests = filetypes.map(filetype => {
      const newIndex = Math.max(...this.mapItems().map(item => item.lnum)) + 1
      const newSnippet = {
        content: [{
          label: 'Fragment 1',
          value: text.replace(/\n$/, ''),
          language: filetype,
        }],
        createdAt: Date.now(),
        folderId: `${newIndex}`,
        id: `${newIndex}`,
        isDeleted: false,
        isFavorites: false,
        name,
        updatedAt: Date.now(),
      }

      // Add the new snippet so it is available immediately.
      // Calling this.init() here does not work
      this.massCodeItems.push(newSnippet)
      return promisifyHttpRequest(config, onEnd, JSON.stringify(newSnippet))
    })

    await Promise.all(requests)
  }
}

async function promisifyHttpRequest<T = any>(config: HttpConfig, onEnd: OnEnd, body?: string): Promise<T> {
  const options = { ...config }

  if (options.method === 'POST' && body.length) {
    options.headers = {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    }
  }

  return new Promise(function(resolve, reject) {
    const req = http.request(options, function(res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error('statusCode=' + res.statusCode));
      }
      const body = []
      res.on('data', function(chunk) {
        body.push(chunk)
      })
      res.on('end', function() {
        onEnd(resolve, reject, body)
      })
    })
    req.on('error', function(err: HttpError) {
      if (err.code === 'ECONNREFUSED') {
        window.showErrorMessage('massCode is not running')
      } else {
        reject(err)
      }
    })
    if (body) {
      req.write(body)
    }
    req.end()
  })
}
