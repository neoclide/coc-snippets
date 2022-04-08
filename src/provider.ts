import { CancellationToken, CompletionItem, CompletionItemKind, CompletionItemProvider, Disposable, Document, InsertTextFormat, OutputChannel, Position, Range, snippetManager, window, workspace } from 'coc.nvim'
import path from 'path'
import BaseProvider from './baseProvider'
import { Snippet, SnippetEditWithSource, VimCompletionContext, TriggerKind } from './types'
import { characterIndex, markdownBlock } from './util'

export class ProviderManager implements CompletionItemProvider {
  private providers: Map<string, BaseProvider> = new Map()
  constructor(
    private channel: OutputChannel,
    subscriptions: Disposable[]
  ) {
    subscriptions.push(Disposable.create(() => {
      this.providers.clear()
    }))
  }

  public regist(provider: BaseProvider, name: string): Disposable {
    this.providers.set(name, provider)
    return Disposable.create(() => {
      this.providers.delete(name)
    })
  }

  public get hasProvider(): boolean {
    return this.providers.size > 0
  }

  public async init(): Promise<void> {
    let providers = Array.from(this.providers.values())
    await Promise.all(providers.map(provider => {
      return provider.init()
    })).catch(e => {
      workspace.nvim.echoError(e)
      this.appendError('init', e)
    })
  }

  public getSnippets(filetype: string): Snippet[] {
    let names = Array.from(this.providers.keys())
    let list: Snippet[] = []
    for (let name of names) {
      let provider = this.providers.get(name)
      try {
        let snippets = provider.getSnippets(filetype)
        snippets.map(s => s.provider = name)
        list.push(...snippets)
      } catch (e) {
        this.appendError(`getSnippets of ${name}`, e)
      }
    }
    list.sort((a, b) => {
      if (a.filetype != b.filetype && (a.filetype == filetype || b.filetype == filetype)) {
        return a.filetype == filetype ? -1 : 1
      }
      if (a.priority != b.priority) {
        return b.priority - a.priority
      }
      if (a.filepath != b.filepath) {
        return b.filepath > a.filepath ? 1 : -1
      }
      return a.lnum - b.lnum
    })
    return list
  }

  public async getSnippetFiles(filetype: string): Promise<string[]> {
    let files: string[] = []
    for (let [name, provider] of this.providers.entries()) {
      try {
        let res = await provider.getSnippetFiles(filetype)
        files = files.concat(res)
      } catch (e) {
        this.appendError(`getSnippetFiles of ${name}`, e)
      }
    }
    return files
  }

  public async getTriggerSnippets(bufnr: number, autoTrigger = false, position?: Position): Promise<SnippetEditWithSource[]> {
    let doc = workspace.getDocument(bufnr)
    if (!doc) return []
    if (!position) position = await window.getCursorPosition()
    let names = Array.from(this.providers.keys())
    let list: SnippetEditWithSource[] = []
    for (let name of names) {
      let provider = this.providers.get(name)
      try {
        let items = await provider.getTriggerSnippets(doc, position, autoTrigger)
        for (let item of items) {
          list.push(Object.assign({ source: name }, item))
        }
      } catch (e) {
        this.appendError(`get trigger snippets of ${name}`, e)
      }
    }
    list.sort((a, b) => b.priority - a.priority)
    if (list.length > 1) {
      let priority = list[0].priority
      list = list.filter(o => o.priority == priority)
    }
    return list
  }

  private appendError(name: string, e: Error | string): void {
    this.channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] Error on ${name}: ${typeof e === 'string' ? e : e.message}`)
    if (e instanceof Error) {
      this.channel.appendLine(e.stack)
    }
  }

  public async provideCompletionItems(
    document,
    position: Position,
    _token: CancellationToken,
    context: VimCompletionContext): Promise<CompletionItem[]> {
    let doc = workspace.getDocument(document.uri)
    if (!doc) return []
    let snippets = this.getSnippets(doc.filetype)
    let currline = doc.getline(position.line, true)
    let { input, col, line } = context.option
    let character = characterIndex(line, col)
    let before_content = currline.slice(0, character)
    let res: CompletionItem[] = []
    for (let snip of snippets) {
      if (snip.context || snip.prefix === '') continue
      if (input.length == 0 && !before_content.endsWith(snip.prefix)) continue
      let contentBehind = before_content
      let head = this.getPrefixHead(doc, snip.prefix)
      let ultisnip = snip.provider == 'ultisnips' || snip.provider == 'snipmate'
      let item: CompletionItem = {
        label: snip.prefix,
        kind: CompletionItemKind.Snippet,
        filterText: snip.prefix,
        detail: snip.description,
        insertTextFormat: InsertTextFormat.Snippet
      }
      item.data = {
        snip,
        provider: snip.provider,
        filepath: `${path.basename(snip.filepath)}:${snip.lnum}`
      }
      if (ultisnip) {
        item.data.ultisnip = {
          context: snip.context,
          regex: snip.originRegex
        }
      }
      if (snip.regex) {
        if (!input.length || snip.prefix && input[0] != snip.prefix[0]) continue
        let content = before_content + snip.prefix
        let ms = content.match(snip.regex)
        if (!ms) continue
      } else if (head && before_content.endsWith(head)) {
        contentBehind = before_content.slice(0, - head.length)
        Object.assign(item, {
          textEdit: {
            range: Range.create({ line: position.line, character: character - head.length }, position),
            newText: snip.prefix
          }
        })
      } else if (input.length == 0) {
        let { prefix } = snip
        contentBehind = before_content.slice(0, - prefix.length)
        Object.assign(item, {
          preselect: true,
          textEdit: {
            range: Range.create({ line: position.line, character: character - prefix.length }, position),
            newText: snip.prefix
          }
        })
      }
      if (snip.triggerKind == TriggerKind.LineBegin && contentBehind.trim().length) continue
      if (snip.triggerKind == TriggerKind.SpaceBefore) {
        if (contentBehind.length && !/\s/.test(contentBehind[contentBehind.length - 1])) {
          continue
        }
      }
      if (!item.textEdit) {
        item.textEdit = {
          range: Range.create({ line: position.line, character }, position),
          newText: snip.prefix
        }
      }
      res.push(item)
    }
    return res
  }

  public async resolveCompletionItem(item: CompletionItem): Promise<CompletionItem> {
    let provider = this.providers.get(item.data.provider)
    if (provider) {
      let doc = workspace.getDocument(workspace.bufnr)
      let filetype = doc ? doc.filetype : undefined
      let insertSnippet = item.data.snip.body
      if (snippetManager && insertSnippet) {
        if (typeof provider.resolveSnippetBody === 'function') {
          insertSnippet = await Promise.resolve(provider.resolveSnippetBody(insertSnippet))
        }
        item.textEdit.newText = insertSnippet
        let resolved = await snippetManager.resolveSnippet(insertSnippet, item.data.ultisnip)
        if (typeof resolved !== 'string') {
          window.showErrorMessage(`Please upgrade your coc.nvim to use coc-snippets`)
          return
        }
        let ms = filetype?.match(/^\w+/)
        let block = markdownBlock(resolved, ms == null ? 'txt' : ms[0])
        item.documentation = {
          kind: 'markdown',
          value: block + (item.data.filepath ? `\n${item.data.filepath}` : '')
        }
      }
    }
    return item
  }

  private getPrefixHead(doc: Document, prefix: string): string {
    let res = 0
    for (let idx = prefix.length - 1; idx >= 0; idx--) {
      if (!doc.isWord(prefix[idx])) {
        res = idx
        break
      }
    }
    return res == 0 ? '' : prefix.slice(0, res + 1)
  }
}
