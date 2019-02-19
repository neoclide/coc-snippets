/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { CompleteOption, CompletionItemProvider, Document, workspace, resolveSnippet } from 'coc.nvim'
import { CancellationToken, CompletionContext, CompletionItem, Disposable, InsertTextFormat, Position, Range, TextDocument, CompletionItemKind } from 'vscode-languageserver-protocol'
import { Snippet, SnippetEdit, TriggerKind } from './types'
import { flatten } from './util'
import BaseProvider from './baseProvider'

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
    let doc = await workspace.document
    let list = names.map(name => {
      let provider = this.providers.get(name)
      let snippets = provider.getSnippets(doc.filetype)
      snippets.map(s => s.provider = name)
      return snippets
    })
    return flatten(list)
  }

  public async getSnippetFiles(): Promise<string[]> {
    let doc = await workspace.document
    if (!doc) return []
    let files: string[] = []
    for (let provider of this.providers.values()) {
      files = files.concat(provider.getSnippetFiles(doc.filetype))
    }
    return files
  }

  public async getTriggerSnippets(): Promise<SnippetEdit[]> {
    let { document, position } = await workspace.getCurrentState()
    let doc = workspace.getDocument(document.uri)
    let names = Array.from(this.providers.keys())
    let list: SnippetEdit[] = []
    for (let name of names) {
      let provider = this.providers.get(name)
      let items = await provider.getTriggerSnippets(doc, position)
      for (let item of items) {
        if (list.findIndex(o => o.prefix == item.prefix) == -1) {
          list.push(item)
        }
      }
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
    let ahead = currline.slice(0, col)
    let res: CompletionItem[] = []
    for (let snip of snippets) {
      let lineBeggining = ahead.trim().length == 0
      let head = this.getPrefixHead(doc, snip.prefix)
      if (!head && input.length == 0) continue
      let item: CompletionItem = {
        label: snip.prefix,
        kind: CompletionItemKind.Snippet,
        filterText: snip.prefix,
        detail: snip.description,
        insertTextFormat: InsertTextFormat.Snippet,
      }
      if (snip.description.length <= 20) {
        Object.assign(item, {
          label: `${item.label} - ${snip.description}`,
          detail: null
        })
      }
      item.data = {
        provider: snip.provider,
        body: snip.body
      }
      if (head) {
        if (ahead.endsWith(head)) {
          lineBeggining = ahead.slice(0, - head.length).trim().length == 0
          let prefix = snip.prefix.slice(head.length)
          Object.assign(item, {
            textEdit: {
              range: Range.create({ line: position.line, character: col - head.length }, position),
              newText: prefix
            }
          })
        }
      }
      if (snip.triggerKind == TriggerKind.LineBegin && !lineBeggining) continue
      if (snip.triggerKind == TriggerKind.InWord) {
        if (!input.endsWith(snip.prefix)) continue
        item.textEdit = {
          newText: item.label, // fix it on resolve
          range: Range.create(position.line, position.character - snip.prefix.length, position.line, position.character)
        }
      }
      if (!item.textEdit) {
        item.textEdit = {
          range: Range.create({ line: position.line, character: col }, position),
          newText: item.label
        }
      }
      item.data.location = `${snip.filepath}:${snip.lnum}`
      res.push(item)
    }
    return res
  }

  public async resolveCompletionItem(item: CompletionItem): Promise<CompletionItem> {
    let provider = this.providers.get(item.data.provider)
    if (provider) {
      let { start } = item.textEdit!.range
      let insertSnippet = await provider.resolveSnippetBody(item.data.body, start)
      item.textEdit.newText = insertSnippet
      if (resolveSnippet) {
        let snip = resolveSnippet(insertSnippet)
        item.documentation = snip.toString()
      }
      // item.detail = item.data.location
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
