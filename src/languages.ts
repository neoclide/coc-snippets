import { CancellationToken, CompleteOption, CompletionContext, CompletionItem, CompletionItemKind, CompletionItemProvider, Diagnostic, DiagnosticCollection, DiagnosticSeverity, Disposable, InsertTextFormat, languages, OutputChannel, Position, ProviderResult, Range, snippetManager, TextDocument, workspace, WorkspaceConfiguration } from 'coc.nvim'
import { convertRegex, headTail, markdownBlock } from './util'

const codesMap: Map<number, string> = new Map()
codesMap.set(1, 'invalid snippet line, trigger requried.')
codesMap.set(2, 'invalid snippet option, option "$1" not supported.')
codesMap.set(3, 'invalid python expression, $1')
codesMap.set(4, 'invalid code interpolation, #! not supported.')

const validOptions = ['b', 'i', 'w', 'r', 'e', 'A']

export class LanguageProvider implements CompletionItemProvider {
  public disposables: Disposable[] = []
  private collection: DiagnosticCollection
  constructor(private channel: OutputChannel, private trace = 'error') {
    this.collection = languages.createDiagnosticCollection('snippets')

    for (let doc of workspace.documents) {
      if (this.shouldValidate(doc.uri)) {
        this.validate(doc.uri, doc.getDocumentContent()).catch(e => {
          channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}]: ${e.message}`)
        })
      }
    }
    workspace.onDidOpenTextDocument(async textDocument => {
      let doc = workspace.getDocument(textDocument.uri)
      if (!this.shouldValidate(doc.uri)) return
      await this.validate(doc.uri, doc.getDocumentContent())
    }, null, this.disposables)

    workspace.onDidChangeTextDocument(async ev => {
      let doc = workspace.getDocument(ev.textDocument.uri)
      if (!doc || !this.shouldValidate(doc.uri)) return
      await this.validate(doc.uri, doc.getDocumentContent())
    }, null, this.disposables)

    workspace.onDidCloseTextDocument(e => {
      this.collection.delete(e.uri)
    }, null, this.disposables)
  }

  private shouldValidate(uri: string): boolean {
    return uri.endsWith('.snippets')
  }

  private async validate(uri: string, content: string): Promise<void> {
    let lines = content.split('\n')
    let diagnostics: Diagnostic[] = []
    let curr = 0
    for (let line of lines) {
      if (/^snippet\s*$/.test(line)) {
        let range = Range.create(curr, 0, curr, line.length)
        diagnostics.push(Diagnostic.create(range, codesMap.get(1), DiagnosticSeverity.Error, 1))
        continue
      }
      if (line.startsWith('snippet ')) {
        let content = headTail(line)[1]
        let ms = content.match(/^(.+?)(?:\s+(?:"(.*?)")?(?:\s+"(.*?)")?(?:\s+(\w+))?)?$/)
        let prefix = ms[1]
        if (prefix.length > 2 && prefix[0] == prefix[prefix.length - 1] && !/\w/.test(prefix[0])) {
          prefix = prefix.slice(1, prefix.length - 1)
        }
        let option = ms[4] || ''
        let isExpression = option.indexOf('r') !== -1
        let startCharacter = line.length - option.length
        for (let ch of option) {
          if (validOptions.indexOf(ch) == -1) {
            let range = Range.create(curr, startCharacter, curr, startCharacter + 1)
            let message = codesMap.get(2).replace('$1', ch)
            diagnostics.push(Diagnostic.create(range, message, DiagnosticSeverity.Error, 2))
          }
          startCharacter = startCharacter + 1
        }
        if (isExpression) {
          try {
            convertRegex(prefix)
          } catch (e) {
            let start = line.indexOf(prefix)
            let range = Range.create(curr, start, curr, start + prefix.length)
            let message = codesMap.get(3).replace('$1', e.message)
            diagnostics.push(Diagnostic.create(range, message, DiagnosticSeverity.Error, 3))
          }
        }
      } else {
        let idx = line.indexOf('`#!')
        if (idx !== -1) {
          let range = Range.create(curr, idx, curr, idx + 3)
          let message = codesMap.get(4)
          diagnostics.push(Diagnostic.create(range, message, DiagnosticSeverity.Error, 4))
        }
      }
      curr++
    }
    if (this.trace == 'verbose') {
      this.channel.appendLine(`[Debug ${(new Date()).toLocaleTimeString()}] diagnostics of ${uri} -> ${JSON.stringify(diagnostics)}`)
    }
    this.collection.set(uri, diagnostics)
  }

  public provideCompletionItems(
    _document: TextDocument,
    position: Position,
    _token: CancellationToken,
    context: CompletionContext): ProviderResult<CompletionItem[]> {
    let { input, col } = (context as any).option! as CompleteOption
    if (context.triggerCharacter == '$') {
      return [{
        label: '$VISUAL',
        kind: CompletionItemKind.Snippet,
        // tslint:disable-next-line: no-invalid-template-strings
        detail: '${VISUAL}',
        insertTextFormat: InsertTextFormat.Snippet,
        textEdit: {
          range: Range.create(position.line, position.character - 1, position.line, position.character),
          // tslint:disable-next-line: no-invalid-template-strings
          newText: '\\${VISUAL${1::default}\\}'
        }
      }]
    }
    if (col == 0 && 'snippet'.startsWith(input)) {
      return [{
        label: 'snippet',
        kind: CompletionItemKind.Snippet,
        detail: 'Snippet definition',
        insertTextFormat: InsertTextFormat.Snippet,
        // tslint:disable-next-line: no-invalid-template-strings
        insertText: 'snippet ${1:Tab_trigger} "${2:Description}" ${3:b}\n$0\nendsnippet'
      }]
    }
    return []
  }

  public async resolveCompletionItem(item: CompletionItem): Promise<CompletionItem> {
    // tslint:disable-next-line: deprecation
    let text = item.insertText || item.textEdit.newText
    // tslint:disable-next-line: deprecation
    let snip = await Promise.resolve(snippetManager.resolveSnippet(text))
    item.documentation = {
      kind: 'markdown',
      value: markdownBlock(snip.toString(), 'snippets')
    }
    return item
  }
}

export function registerLanguageProvider(subscriptions: Disposable[], channel: OutputChannel, configuration: WorkspaceConfiguration) {
  let trace = configuration.get<string>('trace', 'error')
  let languageProvider = new LanguageProvider(channel, trace)
  subscriptions.push(languages.registerCompletionItemProvider(
    'snippets-source',
    configuration.get('shortcut', 'S'),
    ['snippets'],
    languageProvider,
    ['$'],
    configuration.get<number>('priority', 90)))
}
