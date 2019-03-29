/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { CompleteOption, CompletionItemProvider, Document, snippetManager, workspace } from 'coc.nvim'
import path from 'path'
import { CancellationToken, CompletionContext, CompletionItem, CompletionItemKind, Disposable, InsertTextFormat, Position, Range, TextDocument } from 'vscode-languageserver-protocol'
import BaseProvider from './baseProvider'
import { Snippet, SnippetEdit, TriggerKind } from './types'

export class ProviderManager implements CompletionItemProvider {
  private providers: Map<string, BaseProvider> = new Map()

  public regist(provider, name): Disposable {
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
    }))
  }

  public async getSnippets(): Promise<Snippet[]> {
    let names = Array.from(this.providers.keys())
    let list: Snippet[] = []
    for (let name of names) {
      let provider = this.providers.get(name)
      let snippets = await provider.getSnippets()
      snippets.map(s => s.provider = name)
      list.push(...snippets)
    }
    return list
  }

  public async getSnippetFiles(): Promise<string[]> {
    let files: string[] = []
    for (let provider of this.providers.values()) {
      let res = await provider.getSnippetFiles()
      files = files.concat(res)
    }
    return files
  }

  public async getTriggerSnippets(autoTrigger = false): Promise<SnippetEdit[]> {
    let bufnr = await workspace.nvim.call('bufnr', '%')
    let doc = workspace.getDocument(bufnr)
    if (!doc) return []
    let position = await workspace.getCursorPosition()
    let names = Array.from(this.providers.keys())
    let list: SnippetEdit[] = []
    for (let name of names) {
      let provider = this.providers.get(name)
      let items = await provider.getTriggerSnippets(doc, position, autoTrigger)
      for (let item of items) {
        if (list.findIndex(o => o.prefix == item.prefix) == -1) {
          list.push(item)
        }
      }
    }
    list.sort((a, b) => b.priority - a.priority)
    if (list.length > 1 && list[0].priority > 0) {
      list = list.filter(o => o.priority > 0)
    }
    return list
  }

  public async provideCompletionItems(
    document: TextDocument,
    position: Position,
    _token: CancellationToken,
    context: CompletionContext): Promise<CompletionItem[]> {
    let doc = workspace.getDocument(document.uri)
    if (!doc) return []
    let snippets = await this.getSnippets()
    let currline = doc.getline(position.line, true)
    let { input, col } = (context as any).option! as CompleteOption
    let before_content = currline.slice(0, col)
    let res: CompletionItem[] = []
    let contextPrefixes: string[] = []
    for (let snip of snippets) {
      let contentBehind = before_content
      if (contextPrefixes.indexOf(snip.prefix) !== -1) continue
      if (snip.regex != null && snip.prefix == '') continue
      if (snip.context) {
        let provider = this.providers.get(snip.provider)
        let valid = await provider.checkContext(snip.context)
        if (!valid) continue
        contextPrefixes.push(snip.prefix)
      }
      let head = this.getPrefixHead(doc, snip.prefix)
      if (input.length == 0 && !before_content.endsWith(snip.prefix)) continue
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
      if (snip.regex) {
        if (!input.length || snip.prefix && input[0] != snip.prefix[0]) continue
        let content = before_content + snip.prefix
        let ms = content.match(snip.regex)
        if (!ms) continue
      } else if (head && before_content.endsWith(head)) {
        contentBehind = before_content.slice(0, - head.length)
        let prefix = snip.prefix.slice(head.length)
        Object.assign(item, {
          textEdit: {
            range: Range.create({ line: position.line, character: col - head.length }, position),
            newText: prefix
          }
        })
      } else if (input.length == 0) {
        let { prefix } = snip
        contentBehind = before_content.slice(0, - prefix.length)
        Object.assign(item, {
          preselect: true,
          textEdit: {
            range: Range.create({ line: position.line, character: col - prefix.length }, position),
            newText: prefix
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
          range: Range.create({ line: position.line, character: col }, position),
          newText: item.label
        }
      }
      item.data.location = `${snip.filepath}:${snip.lnum}`
      item.data.line = contentBehind + snip.prefix
      res.push(item)
    }
    return res
  }

  public async resolveCompletionItem(item: CompletionItem): Promise<CompletionItem> {
    let provider = this.providers.get(item.data.provider)
    if (provider) {
      let insertSnippet = await provider.resolveSnippetBody(item.data.snip, item.textEdit.range, item.data.line)
      item.textEdit.newText = insertSnippet
      if (snippetManager) {
        let snip = await Promise.resolve(snippetManager.resolveSnippet(insertSnippet))
        item.documentation = snip.toString()
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
