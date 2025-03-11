import { CancellationToken, CompletionItem, CompletionItemKind, CompletionItemProvider, Disposable, Document, InsertTextFormat, LinesTextDocument, OutputChannel, Position, Range, snippetManager, TextEditor, window, workspace, WorkspaceConfiguration } from 'coc.nvim'
import path from 'path'
import BaseProvider from './baseProvider'
import { Snippet, SnippetEditWithSource, TriggerKind, VimCompletionContext } from './types'
import { characterIndex, getSnippetFiletype, markdownBlock } from './util'

export class ProviderManager implements CompletionItemProvider {
  private providers: Map<string, BaseProvider> = new Map()
  constructor(
    private channel: OutputChannel,
    private subscriptions: Disposable[],
    private configuration: WorkspaceConfiguration
  ) {
    this.subscriptions.push(Disposable.create(() => {
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
    await Promise.allSettled(providers.map(provider => provider.init().catch(e => {
      workspace.nvim.echoError(e)
      this.appendError('Error on provider init:', e)
    })))

    let promises: Promise<void>[] = []
    workspace.documents.forEach(doc => {
      let filetype = getSnippetFiletype(doc)
      promises.push(this.loadSnippetsByFiletype(filetype))
    })
    let filetype: string | undefined
    let doc = window.activeTextEditor?.document
    if (doc) filetype = doc.filetype
    window.onDidChangeActiveTextEditor(async (e: TextEditor) => {
      let newFiletype = e.document?.filetype
      if (newFiletype && newFiletype != filetype) {
        filetype = newFiletype
        let bufnr = e.document.bufnr
        await Promise.allSettled(providers.map(provider => provider.onFiletypeChange(bufnr, filetype).catch(e => {
          this.appendError('Error on filetype change:', e)
        })))
      }
    }, null, this.subscriptions)
    workspace.onDidOpenTextDocument(async doc => {
      let filetype = getSnippetFiletype({ bufnr: doc.bufnr, filetype: doc.languageId })
      await this.loadSnippetsByFiletype(filetype)
    }, null, this.subscriptions)
    await Promise.allSettled(promises)
  }

  public async loadSnippetsByFiletype(filetype: string): Promise<void> {
    let promises: Promise<void>[] = []
    for (let [name, provider] of this.providers.entries()) {
      promises.push(provider.loadSnippetsByFiletype(filetype).catch(e => {
        this.appendError(`Error on load "${name}" snippets:`, e)
      }))
    }
    await Promise.allSettled(promises)
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

  private checkSyntax(syntax: string): boolean {
    let syntaxes = this.configuration.inspect<string[]>('disableSyntaxes').globalValue ?? []
    if (syntaxes.length == 0) return true
    try {
      for (let str of syntaxes) {
        let r = new RegExp(str, 'i')
        if (r.test(syntax)) return false
      }
    } catch (e) {
      // ignore
    }
    return true
  }

  public async provideCompletionItems(document: LinesTextDocument, position: Position, _token: CancellationToken, context: VimCompletionContext): Promise<CompletionItem[]> {
    let doc = workspace.getDocument(document.uri)
    if (!doc || !this.checkSyntax(context.option.synname)) return []
    let bufnr = doc.bufnr
    let filetype = getSnippetFiletype(doc)
    let snippets = this.getSnippets(filetype)
    let currline = doc.getline(position.line, true)
    let { input, col, line, colnr } = context.option
    let character = characterIndex(line, col)
    let before_content = currline.slice(0, character)
    let after = line.slice(characterIndex(line, colnr - 1))
    let res: CompletionItem[] = []
    let noneWords = before_content.endsWith(' ') ? '' : before_content.match(/\W*$/)[0]
    let contextPrefixes: string[] = []
    const execContext = this.configuration.inspect('execContext').globalValue ?? false
    for (let snip of snippets) {
      if (!execContext && snip.context) continue
      if (snip.prefix === '') continue
      if (input.length == 0 && (!snip.special || !before_content.endsWith(snip.special))) continue
      if (contextPrefixes.indexOf(snip.prefix) !== -1) continue
      let contentBefore = before_content
      if (snip.context) {
        let provider = this.providers.get(snip.provider)
        let valid: boolean
        try {
          valid = await provider.checkContext(snip.context)
        } catch (e) {
          this.appendError(`checkContext of ${snip.provider}`, e)
          valid = false
        }
        if (!valid) continue
        contextPrefixes.push(snip.prefix)
      }
      let head = this.getPrefixHead(doc, snip.prefix)
      let ultisnip = snip.provider == 'ultisnips' || snip.provider == 'snipmate'
      let startCharacter = character
      let item: CompletionItem = {
        label: snip.prefix,
        kind: CompletionItemKind.Snippet,
        filterText: snip.prefix,
        detail: snip.description,
        insertTextFormat: InsertTextFormat.Snippet
      }
      // check common begin for special characters
      if (noneWords && snip.special) {
        if (noneWords.endsWith(snip.special)) {
          let len = snip.special.length
          item.filterText = item.filterText.slice(len)
          startCharacter = character - len
          contentBefore = contentBefore.slice(0, -len)
        } else {
          continue
        }
      }
      item.data = {
        bufnr,
        snip,
        provider: snip.provider,
        filepath: `${path.basename(snip.filepath)}:${snip.lnum}`
      }
      if (ultisnip) {
        // range line
        // before_content snip.prefix
        let formatOptions = snip.formatOptions ?? {}
        let actions = snip.actions ?? {}
        item.data.ultisnip = {
          actions,
          context: snip.context,
          regex: snip.originRegex,
          range: Range.create(position.line, startCharacter, position.line, character + snip.prefix.length),
          line: before_content + snip.prefix + after,
          noExpand: formatOptions.noExpand,
          trimTrailingWhitespace: formatOptions.trimTrailingWhitespace,
          removeWhiteSpace: formatOptions.removeWhiteSpace
        }
      }
      if (snip.regex) {
        if (!input.length || snip.prefix && input[0] != snip.prefix[0]) continue
        let content = before_content + snip.prefix
        let ms = content.match(snip.regex)
        if (!ms) continue
      } else if (head && before_content.endsWith(head)) {
        contentBefore = before_content.slice(0, - head.length)
        Object.assign(item, {
          textEdit: {
            range: Range.create({ line: position.line, character: startCharacter }, position),
            newText: snip.prefix
          }
        })
      } else if (input.length == 0) {
        // let { special } = snip
        // contentBefore = before_content.slice(0, - special.length)
        Object.assign(item, {
          preselect: true,
          textEdit: {
            range: Range.create({ line: position.line, character: startCharacter }, position),
            newText: snip.prefix
          }
        })
      }
      if (snip.triggerKind == TriggerKind.LineBegin && contentBefore.trim().length) continue
      if (snip.triggerKind == TriggerKind.SpaceBefore) {
        if (contentBefore.length && !/\s/.test(contentBefore[contentBefore.length - 1])) {
          continue
        }
      }
      if (!item.textEdit) {
        item.textEdit = {
          range: Range.create({ line: position.line, character: startCharacter }, position),
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
      let doc = workspace.getDocument(item.data.bufnr)
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
