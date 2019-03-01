/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { ExtensionContext, events, listManager, commands, languages, workspace, VimCompleteItem, snippetManager } from 'coc.nvim'
import SnippetsList from './list/snippet'
import { ProviderManager } from './provider'
import { UltiSnippetsProvider } from './ultisnipsProvider'
import { UltiSnipsConfig } from './types'
import { SnippetsProvider } from './snippetsProvider'
import { Range, Position } from 'vscode-languageserver-types'
import { wait } from './util'

export async function activate(context: ExtensionContext): Promise<void> {
  let { subscriptions } = context
  const configuration = workspace.getConfiguration('snippets')
  const filetypeExtends = configuration.get('extends', {})
  const manager = new ProviderManager()
  let mru = workspace.createMru('snippets-mru')

  const channel = workspace.createOutputChannel('snippets')

  events.on('CompleteDone', async (item: VimCompleteItem) => {
    if (item.user_data && item.user_data.indexOf('coc-snippets') !== -1) {
      await mru.add(item.word)
    }
  }, null, subscriptions)

  if (configuration.get<boolean>('ultisnips.enable', true)) {
    let config = configuration.get<any>('ultisnips', {})
    let c = Object.assign({}, config, {
      extends: Object.assign({}, filetypeExtends)
    } as UltiSnipsConfig)
    let provider = new UltiSnippetsProvider(c, channel)
    manager.regist(provider, 'ultisnips')
  }

  if (configuration.get<boolean>('loadFromExtensions', true)) {
    let config = { extends: Object.assign({}, filetypeExtends) }
    let provider = new SnippetsProvider(channel, config)
    manager.regist(provider, 'snippets')
  }

  if (configuration.get<boolean>('autoTrigger', true)) {
    let insertTs
    events.on('InsertCharPre', () => {
      insertTs = Date.now()
    })
    events.on(['TextChangedI', 'TextChangedP'], async () => {
      if (!insertTs || Date.now() - insertTs > 50) return
      let curr = insertTs
      await wait(50)
      let edits = await manager.getTriggerSnippets(true)
      if (insertTs != curr) return
      if (edits.length == 0) return
      await workspace.nvim.call('coc#_hide')
      if (edits.length > 1) {
        channel.appendLine(`Multiple snippet found for auto trigger: ${edits.map(s => s.prefix).join(', ')}`)
      }
      await commands.executeCommand('editor.action.insertSnippet', edits[0])
      await mru.add(edits[0].prefix)
    })
  }

  const statusItem = workspace.createStatusBarItem(90, { progress: true })
  statusItem.text = 'loading snippets'
  statusItem.show()
  manager.init().then(() => {
    statusItem.hide()
  }, e => {
    statusItem.hide()
    workspace.showMessage(`Error on load snippets: ${e.message}`, 'error')
  })

  if (manager.hasProvider) {
    let disposable = languages.registerCompletionItemProvider(
      'snippets', 'S', null,
      manager, configuration.get<string[]>('triggerCharacters', []),
      configuration.get<number>('priority', 90))
    subscriptions.push(disposable)
  }

  async function fallback(): Promise<void> {
    let { nvim } = workspace
    let visible = await nvim.call('pumvisible')
    if (visible) {
      let action = configuration.get<string>('expandFallbackWithPum', 'refresh')
      if (action == 'refresh') {
        await nvim.call('coc#start', [{ source: 'snippets' }])
      } else if (action == 'next') {
        await nvim.eval(`feedkeys("\\<C-n>", 'in')`)
      } else if (action == 'confirm') {
        await nvim.call('coc#_select', [])
      } else {
        workspace.showMessage('No match snippet found', 'warning')
      }
      return
    }
    await nvim.call('coc#start', [{ source: 'snippets' }])
  }

  async function doExpand(): Promise<boolean> {
    let edits = await manager.getTriggerSnippets()
    if (edits.length == 0) return false
    if (edits.length == 1) {
      await commands.executeCommand('editor.action.insertSnippet', edits[0])
      await mru.add(edits[0].prefix)
    } else {
      let idx = await workspace.showQuickpick(edits.map(e => e.description), 'choose snippet:')
      if (idx == -1) return
      await commands.executeCommand('editor.action.insertSnippet', edits[idx])
      await mru.add(edits[idx].prefix)
    }
    await workspace.nvim.setVar('coc_selected_text', '')
    return true
  }

  subscriptions.push(workspace.registerKeymap(['i'], 'snippets-expand', async () => {
    let expanded = await doExpand()
    if (!expanded) await fallback()
  }, { silent: true, sync: true, cancel: false }))

  subscriptions.push(workspace.registerKeymap(['i'], 'snippets-expand-jump', async () => {
    let expanded = await doExpand()
    if (!expanded) {
      let bufnr = await workspace.nvim.call('bufnr', '%')
      let session = snippetManager.getSession(bufnr)
      if (session && session.isActive) {
        await snippetManager.nextPlaceholder()
        return
      }
      await fallback()
    }
  }, { silent: true, sync: true, cancel: false }))

  subscriptions.push(workspace.registerKeymap(['v'], 'snippets-select', async () => {
    let doc = await workspace.document
    if (!doc) return
    let { nvim } = workspace
    let mode = await nvim.call('mode')
    if (['v', 'V'].indexOf(mode) == -1) return
    await nvim.call('feedkeys', [String.fromCharCode(27), 'in'])
    await nvim.command('normal! `<')
    let start = await workspace.getCursorPosition()
    await nvim.command('normal! `>')
    let end = await workspace.getCursorPosition()
    end = Position.create(end.line, end.character + 1)
    let range = Range.create(start, end)
    let text = doc.textDocument.getText(range)
    await nvim.call('feedkeys', ['i', 'in'])
    if (mode == 'v') {
      await doc.applyEdits(workspace.nvim, [{ range, newText: '' }])
    } else {
      // keep indent
      let currline = doc.getline(start.line)
      let indent = currline.match(/^\s*/)[0]
      let lines = text.split(/\r?\n/)
      lines = lines.map(s => s.startsWith(indent) ? s.slice(indent.length) : s)
      text = lines.join('\n')
      range = Range.create(Position.create(start.line, indent.length), end)
      await doc.applyEdits(workspace.nvim, [{ range, newText: '' }])
    }
    await nvim.setVar('coc_selected_text', text)
    await workspace.moveTo(range.start)
  }, { silent: true, sync: false, cancel: true }))

  subscriptions.push(statusItem)
  subscriptions.push(channel)
  subscriptions.push(listManager.registerList(new SnippetsList(workspace.nvim as any, manager, mru)))
}
