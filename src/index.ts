/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { ExtensionContext, commands, languages, workspace } from 'coc.nvim'
import { ProviderManager } from './provider'
import { UltiSnippetsProvider } from './ultisnipsProvider'
import { UltiSnipsConfig } from './types'
import { SnippetsProvider } from './snippetsProvider'

export async function activate(context: ExtensionContext): Promise<void> {
  let { subscriptions } = context
  const configuration = workspace.getConfiguration('snippets')
  const filetypeExtends = configuration.get('extends', {})
  const manager = new ProviderManager()

  const channel = workspace.createOutputChannel('snippets')
  const statusItem = workspace.createStatusBarItem(90, { progress: true })
  statusItem.text = 'loading snippets'
  statusItem.show()

  if (configuration.get<boolean>('ultisnips.enable', true)) {
    let config = configuration.get<any>('ultisnips', {})
    let c = Object.assign({}, config, { extends: Object.assign({}, filetypeExtends) } as UltiSnipsConfig)
    let provider = new UltiSnippetsProvider(c, channel)
    await provider.init()
    manager.regist(provider, 'ultisnips')
  }

  if (configuration.get<boolean>('loadFromExtensions', true)) {
    let config = { extends: Object.assign({}, filetypeExtends) }
    let provider = new SnippetsProvider(channel, config)
    await provider.init()
    manager.regist(provider, 'snippets')
  }

  statusItem.hide()

  if (manager.hasProvider) {
    let disposable = languages.registerCompletionItemProvider(
      'coc-snippets', 'S', null,
      manager, [],
      configuration.get<number>('priority', 90))
    subscriptions.push(disposable)
  }

  subscriptions.push(commands.registerCommand('snippets.editSnippets', async () => {
    let files = await manager.getSnippetFiles()
    let { nvim } = workspace
    if (!files.length) {
      workspace.showMessage('No snippet file found', 'warning')
    } else {
      let file = files[0]
      if (files.length > 1) {
        let idx = await workspace.showQuickpick(files, 'choose file')
        if (idx == -1) return
        file = files[idx]
      }
      let escaped = await nvim.call('fnameescape', file)
      await nvim.command(`vsplit ${escaped}`)
    }
  }))

  let disposable = workspace.registerKeymap(['i'], 'snippets-expand', async () => {
    let edits = await manager.getTriggerSnippets()
    if (edits.length == 0) return workspace.showMessage('No matching snippet found', 'warning')
    if (edits.length == 1) {
      await commands.executeCommand('editor.action.insertSnippet', edits[0])
    } else {
      let idx = await workspace.showQuickpick(edits.map(e => e.description), 'choose snippet:')
      if (idx == -1) return
      await commands.executeCommand('editor.action.insertSnippet', edits[idx])
    }
  })

  subscriptions.push(disposable)
  subscriptions.push(statusItem)
  subscriptions.push(channel)
}
