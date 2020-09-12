/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { Uri, commands, events, ExtensionContext, languages, listManager, snippetManager, VimCompleteItem, workspace } from 'coc.nvim'
import os from 'os'
import fs from 'fs'
import path from 'path'
import util from 'util'
import { Position, Range, CodeActionKind, CodeAction, Command, TextEdit } from 'vscode-languageserver-types'
import SnippetsList from './list/snippet'
import { ProviderManager } from './provider'
import { SnipmateProvider } from './snipmateProvider'
import { TextmateProvider } from './textmateProvider'
import { UltiSnipsConfig } from './types'
import { UltiSnippetsProvider } from './ultisnipsProvider'
import debounce from 'debounce'
import LanguageProvider from './languages'

const documentation = `# A valid snippet should starts with:
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

interface API {
  expandable: () => Promise<boolean>
}

export async function activate(context: ExtensionContext): Promise<API> {
  let { subscriptions } = context
  const { nvim } = workspace
  const configuration = workspace.getConfiguration('snippets')
  const filetypeExtends = configuration.get<any>('extends', {})
  const manager = new ProviderManager()
  const trace = configuration.get<string>('trace', 'error')
  let mru = workspace.createMru('snippets-mru')

  const channel = workspace.createOutputChannel('snippets')

  let snippetsDir = configuration.get<string>('userSnippetsDirectory')
  if (snippetsDir) {
    snippetsDir = snippetsDir.replace(/^~/, os.homedir())
    if (snippetsDir.indexOf('$') !== -1) {
      snippetsDir = snippetsDir.replace(/\$(\w+)/g, (match, p1) => {
        return process.env[p1] ?? match
      })
    }
    if (!path.isAbsolute(snippetsDir)) {
      workspace.showMessage(`snippets.userSnippetsDirectory => ${snippetsDir} should be absolute path`, 'warning')
      snippetsDir = null
    }
  }
  if (!snippetsDir) snippetsDir = path.join(path.dirname(workspace.env.extensionRoot), 'ultisnips')
  if (!fs.existsSync(snippetsDir)) {
    await util.promisify(fs.mkdir)(snippetsDir)
  }

  events.on('CompleteDone', async (item: VimCompleteItem) => {
    if (item.user_data && item.user_data.indexOf('snippets') !== -1) {
      await mru.add(item.word)
    }
  }, null, subscriptions)

  workspace.onDidOpenTextDocument(async document => {
    if (document.uri.endsWith('.snippets')) {
      let doc = workspace.getDocument(document.uri)
      if (!doc) return
      let { buffer } = doc
      await buffer.setOption('filetype', 'snippets')
    }
  }, null, subscriptions)

  if (configuration.get<boolean>('ultisnips.enable', true)) {
    let config = configuration.get<any>('ultisnips', {})
    let c = Object.assign({}, config, {
      extends: Object.assign({}, filetypeExtends)
    } as UltiSnipsConfig)
    c.directories = c.directories ? c.directories.slice() : []
    if (c.directories.indexOf(snippetsDir) == -1) {
      c.directories.push(snippetsDir)
    }
    let provider = new UltiSnippetsProvider(channel, trace, c, context)
    manager.regist(provider, 'ultisnips')
    subscriptions.push(provider)
    // add rtp if ultisnips not found
    nvim.getOption('runtimepath').then(async rtp => {
      let paths = (rtp as string).split(',')
      let idx = paths.findIndex(s => /^ultisnips$/i.test(path.basename(s)))
      if (idx !== -1) return
      let directory = path.resolve(__dirname, '..')
      nvim.command('autocmd BufNewFile,BufRead *.snippets setf snippets', true)
      nvim.command(`execute 'noa set rtp+='.fnameescape('${directory.replace(/'/g, "''")}')`, true)
      workspace.documents.forEach(doc => {
        if (doc.uri.endsWith('.snippets')) {
          doc.buffer.setOption('filetype', 'snippets', true)
        }
      })
    }, _e => {
      // noop
    })
  }

  let config = {
    loadFromExtensions: configuration.get<boolean>('loadFromExtensions', true),
    snippetsRoots: configuration.get<string[]>('textmateSnippetsRoots', []),
    extends: Object.assign({}, filetypeExtends)
  }
  let provider = new TextmateProvider(channel, trace, config)
  manager.regist(provider, 'snippets')

  if (configuration.get<boolean>('snipmate.enable', true)) {
    let config = {
      author: configuration.get<string>('snipmate.author', ''),
      extends: Object.assign({}, filetypeExtends)
    }
    let provider = new SnipmateProvider(channel, trace, config)
    manager.regist(provider, 'snipmate')
  }

  if (configuration.get<boolean>('autoTrigger', true)) {
    let insertTs
    events.on('InsertCharPre', () => {
      insertTs = Date.now()
    }, null, subscriptions)
    events.on(['TextChanged', 'TextChangedP', 'TextChangedI'], debounce(async () => {
      if (!workspace.insertMode) return
      if (!insertTs || Date.now() - insertTs > 200) return
      let curr = insertTs
      let edits = await manager.getTriggerSnippets(true)
      if (insertTs != curr || edits.length == 0) return
      if (edits.length > 1) {
        channel.appendLine(`Multiple snippet found for auto trigger: ${edits.map(s => s.prefix).join(', ')}`)
        workspace.showMessage('Multiple snippet found for auto trigger, check output by :CocCommand workspace.showOutput', 'warning')
      }
      await commands.executeCommand('editor.action.insertSnippet', edits[0])
      await mru.add(edits[0].prefix)
    }, 100), null, subscriptions)
  }
  let statusItem
  if (configuration.get<boolean>('enableStatusItem', true)) {
    statusItem = workspace.createStatusBarItem(90, { progress: true })
    statusItem.text = 'loading snippets'
    statusItem.show()
  }
  manager.init().then(() => {
    statusItem?.hide()
  }, e => {
    statusItem?.hide()
    workspace.showMessage(`Error on load snippets: ${e.message}`, 'error')
  })

  if (manager.hasProvider) {
    let disposable = languages.registerCompletionItemProvider(
      'snippets',
      'S',
      null,
      manager, configuration.get<string[]>('triggerCharacters', []),
      configuration.get<number>('priority', 90))
    subscriptions.push(disposable)
  }

  async function fallback(): Promise<void> {
    await nvim.call('coc#start', [{ source: 'snippets' }])
  }

  async function doExpand(): Promise<boolean> {
    let edits = await manager.getTriggerSnippets()
    if (edits.length == 0) return false
    if (edits.length == 1) {
      await commands.executeCommand('editor.action.insertSnippet', edits[0])
      await mru.add(edits[0].prefix)
    } else {
      let idx = await workspace.showQuickpick(edits.map(e => e.description || e.prefix), 'choose snippet:')
      if (idx == -1) return
      await commands.executeCommand('editor.action.insertSnippet', edits[idx])
      await mru.add(edits[idx].prefix)
    }
    return true
  }

  subscriptions.push(workspace.registerKeymap(['x'], 'convert-snippet', async () => {
    let mode = await workspace.nvim.call('visualmode')
    if (!mode) return
    let doc = await workspace.document
    if (!doc) return
    doc.forceSync()
    let range = await workspace.getSelectedRange(mode, doc)
    let text = doc.textDocument.getText(range)
    if (text) await commands.executeCommand('snippets.editSnippets', text)
  }, { sync: false }))

  subscriptions.push(commands.registerCommand('snippets.editSnippets', async (text?: string) => {
    let buf = await nvim.buffer
    let doc = workspace.getDocument(buf.id)
    if (!doc) {
      workspace.showMessage('Document not found', 'error')
      return
    }
    let file = path.join(snippetsDir, `${doc.filetype}.snippets`)
    if (!fs.existsSync(file)) {
      await util.promisify(fs.writeFile)(file, documentation, 'utf8')
    }
    let uri = Uri.file(file).toString()
    await workspace.jumpTo(uri, null, configuration.get<string>('editSnippetsCommand'))
    if (text) {
      await nvim.command('normal! G')
      await nvim.command('normal! 2o')
      let position = await workspace.getCursorPosition()
      let indent = text.match(/^\s*/)[0]
      text = text.split(/\r?\n/).map(s => s.startsWith(indent) ? s.slice(indent.length) : s).join('\n')
      let escaped = text.replace(/([$}\]])/g, '\\$1')
      // tslint:disable-next-line: no-invalid-template-strings
      let snippet = 'snippet ${1:Tab_trigger} "${2:Description}" ${3:b}\n' + escaped + '\nendsnippet'
      let edit = TextEdit.insert(position, snippet)
      await commands.executeCommand('editor.action.insertSnippet', edit)
    }
  }))

  subscriptions.push(commands.registerCommand('snippets.openSnippetFiles', async () => {
    let buf = await nvim.buffer
    let doc = workspace.getDocument(buf.id)
    if (!doc) {
      workspace.showMessage('Document not found', 'error')
      return
    }
    let files = await manager.getSnippetFiles(doc.filetype)
    if (!files.length) {
      workspace.showMessage('No related snippet file found', 'warning')
      return
    }
    let idx = await workspace.showQuickpick(files, 'choose snippet file:')
    if (idx == -1) return
    let uri = Uri.file(files[idx]).toString()
    await workspace.jumpTo(uri, null, configuration.get<string>('editSnippetsCommand'))
  }))

  subscriptions.push(workspace.registerKeymap(['i'], 'snippets-expand', async () => {
    let expanded = await doExpand()
    if (!expanded) await fallback()
  }, { silent: true, sync: true, cancel: true }))

  subscriptions.push(workspace.registerKeymap(['i'], 'snippets-expand-jump', async () => {
    let expanded = await doExpand()
    if (!expanded) {
      let bufnr = await nvim.call('bufnr', '%')
      let session = snippetManager.getSession(bufnr)
      if (session && session.isActive) {
        await nvim.call('coc#_cancel', [])
        await snippetManager.nextPlaceholder()
        return
      }
      await fallback()
    }
  }, { silent: true, sync: true, cancel: true }))

  subscriptions.push(workspace.registerKeymap(['v'], 'snippets-select', async () => {
    let doc = await workspace.document
    if (!doc) return
    let mode = await nvim.call('visualmode')
    if (['v', 'V'].indexOf(mode) == -1) {
      workspace.showMessage(`visual mode ${mode} not supported`, 'warning')
      return
    }
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

  let languageProvider = new LanguageProvider(channel, trace)
  subscriptions.push(languages.registerCompletionItemProvider(
    'snippets-source',
    'S',
    ['snippets'],
    languageProvider,
    ['$'],
    configuration.get<number>('priority', 90)))
  subscriptions.push(statusItem)
  subscriptions.push(channel)
  subscriptions.push(listManager.registerList(new SnippetsList(workspace.nvim as any, manager, mru)))

  return {
    expandable: async (): Promise<boolean> => {
      let edits
      try {
        edits = await manager.getTriggerSnippets()
      } catch (e) {
        channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] Error on getTriggerSnippets: ${e}`)
      }
      return edits && edits.length > 0
    }
  }
}
