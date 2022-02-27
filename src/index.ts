import { commands, Disposable, events, ExtensionContext, languages, listManager, Position, Range, snippetManager, TextEdit, Uri, VimCompleteItem, window, workspace, WorkspaceConfiguration } from 'coc.nvim'
import fs from 'fs'
import path from 'path'
import util from 'util'
import LanguageProvider from './languages'
import SnippetsList from './list/snippet'
import { ProviderManager } from './provider'
import { SnipmateProvider } from './snipmateProvider'
import { TextmateProvider } from './textmateProvider'
import { UltiSnipsConfig } from './types'
import { UltiSnippetsProvider } from './ultisnipsProvider'
import { documentation, waitDocument } from './util'

interface API {
  expandable: () => Promise<boolean>
}

/*
 * Get user snippets directory.
 */
async function getSnippetsDirectory(configuration: WorkspaceConfiguration): Promise<string> {
  let snippetsDir = configuration.get<string>('userSnippetsDirectory')
  if (snippetsDir) {
    snippetsDir = workspace.expand(snippetsDir)
    if (!path.isAbsolute(snippetsDir)) {
      window.showMessage(`snippets.userSnippetsDirectory => ${snippetsDir} should be absolute path`, 'warning')
      snippetsDir = null
    }
  }
  if (!snippetsDir) snippetsDir = path.join(path.dirname(workspace.env.extensionRoot), 'ultisnips')
  if (!fs.existsSync(snippetsDir)) {
    await fs.promises.mkdir(snippetsDir)
  }
  return snippetsDir
}

function enableSnippetsFiletype(subscriptions: Disposable[]) {
  let { nvim } = workspace
  workspace.documents.forEach(doc => {
    if (doc.uri.endsWith('.snippets')) {
      doc.buffer.setOption('filetype', 'snippets', true)
    }
  })
  workspace.onDidOpenTextDocument(async document => {
    if (document.uri.endsWith('.snippets')) {
      let doc = workspace.getDocument(document.uri)
      if (!doc) return
      let { buffer } = doc
      await buffer.setOption('filetype', 'snippets')
    }
  }, null, subscriptions)
  const rtp = workspace.env.runtimepath
  let paths = rtp.split(',')
  let idx = paths.findIndex(s => /^ultisnips$/i.test(path.basename(s)))
  if (idx === -1) {
    let directory = path.resolve(__dirname, '..')
    nvim.command('autocmd BufNewFile,BufRead *.snippets setf snippets', true)
    nvim.command(`execute 'noa set rtp+='.fnameescape('${directory.replace(/'/g, "''")}')`, true)
  }
}

async function snippetSelect(): Promise<void> {
  let doc = await workspace.document
  if (!doc) return
  let { nvim } = workspace
  let mode = await nvim.call('visualmode')
  if (['v', 'V'].indexOf(mode) == -1) {
    window.showMessage(`visual mode ${mode} not supported`, 'warning')
    return
  }
  await nvim.command('normal! `<')
  let start = await window.getCursorPosition()
  await nvim.command('normal! `>')
  let end = await window.getCursorPosition()
  end = Position.create(end.line, end.character + 1)
  let range = Range.create(start, end)
  let text = doc.textDocument.getText(range)
  await nvim.call('feedkeys', ['i', 'in'])
  if (mode == 'v') {
    await doc.applyEdits([{ range, newText: '' }])
  } else {
    // keep indent
    let currline = doc.getline(start.line)
    let indent = currline.match(/^\s*/)[0]
    let lines = text.split(/\r?\n/)
    lines = lines.map(s => s.startsWith(indent) ? s.slice(indent.length) : s)
    text = lines.join('\n')
    range = Range.create(Position.create(start.line, indent.length), end)
    await doc.applyEdits([{ range, newText: '' }])
  }
  await nvim.setVar('coc_selected_text', text)
  await window.moveTo(range.start)
}

export async function activate(context: ExtensionContext): Promise<API> {
  let { subscriptions } = context
  const { nvim } = workspace
  const configuration = workspace.getConfiguration('snippets')
  const filetypeExtends = configuration.get<any>('extends', {})
  const trace = configuration.get<string>('trace', 'error')
  const snippetsDir = await getSnippetsDirectory(configuration)
  let mru = workspace.createMru('snippets-mru')
  const channel = window.createOutputChannel('snippets')
  const manager = new ProviderManager(channel, subscriptions)

  events.on('CompleteDone', async (item: VimCompleteItem) => {
    if (typeof item.user_data === 'string' && item.user_data.indexOf('snippets') !== -1) {
      await mru.add(item.word)
    }
  }, null, subscriptions)

  enableSnippetsFiletype(subscriptions)
  let excludes = configuration.get<string[]>('excludePatterns', [])
  if (!Array.isArray(excludes)) excludes = []
  excludes = excludes.map(p => workspace.expand(p))
  if (configuration.get<boolean>('ultisnips.enable', true)) {
    let config = configuration.get<any>('ultisnips', {})
    let c = Object.assign({}, config, {
      excludes,
      extends: Object.assign({}, filetypeExtends)
    } as UltiSnipsConfig)
    c.directories = c.directories ? c.directories.slice() : []
    if (c.directories.indexOf(snippetsDir) == -1) {
      c.directories.push(snippetsDir)
    }
    let provider = new UltiSnippetsProvider(channel, trace, c, context)
    manager.regist(provider, 'ultisnips')
  }

  if (configuration.loadFromExtensions || configuration.textmateSnippetsRoots?.length > 0) {
    const config = {
      loadFromExtensions: configuration.get<boolean>('loadFromExtensions', true),
      snippetsRoots: configuration.get<string[]>('textmateSnippetsRoots', []),
      extends: Object.assign({}, filetypeExtends),
      excludes
    }
    let provider = new TextmateProvider(channel, config, subscriptions)
    manager.regist(provider, 'snippets')
  }

  if (configuration.get<boolean>('snipmate.enable', true)) {
    let config = {
      author: configuration.get<string>('snipmate.author', ''),
      extends: Object.assign({}, filetypeExtends),
      excludes
    }
    let provider = new SnipmateProvider(channel, config, subscriptions)
    manager.regist(provider, 'snipmate')
  }

  if (configuration.get<boolean>('autoTrigger', true)) {
    let inserting = false
    events.on('TextInsert', async (bufnr, info) => {
      let changedtick = info.changedtick
      if (inserting) return
      let doc = workspace.getDocument(bufnr)
      if (!doc || doc.isCommandLine || !doc.attached) return
      let res = await waitDocument(doc, changedtick)
      if (!res) return
      let edits = await manager.getTriggerSnippets(bufnr, true)
      if (edits.length == 0) return
      if (edits.length > 1) {
        channel.appendLine(`Multiple snippet found for auto trigger: ${edits.map(s => s.prefix).join(', ')}`)
        window.showMessage('Multiple snippet found for auto trigger, check output by :CocCommand workspace.showOutput', 'warning')
      }
      if (inserting) return
      inserting = true
      try {
        await commands.executeCommand('editor.action.insertSnippet', edits[0])
        await mru.add(edits[0].prefix)
      } catch (e) {
        console.error(e)
      }
      inserting = false
    }, null, subscriptions)
  }
  manager.init().catch(e => {
    channel.appendLine(`[Error ${(new Date()).toLocaleTimeString()}] Error on init: ${e.stack}`)
  })

  if (manager.hasProvider) {
    let disposable = languages.registerCompletionItemProvider(
      'snippets',
      configuration.get('shortcut', 'S'),
      null,
      manager, configuration.get<string[]>('triggerCharacters', []),
      configuration.get<number>('priority', 90))
    subscriptions.push(disposable)
  }

  async function fallback(): Promise<void> {
    await nvim.call('coc#start', [{ source: 'snippets' }])
  }

  async function doExpand(bufnr: number): Promise<boolean> {
    let edits = await manager.getTriggerSnippets(bufnr)
    if (edits.length == 0) return false
    if (edits.length == 1) {
      await commands.executeCommand('editor.action.insertSnippet', edits[0])
      await mru.add(edits[0].prefix)
    } else {
      let idx = await window.showQuickpick(edits.map(e => e.description || e.prefix), 'choose snippet:')
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
    let range = await window.getSelectedRange(mode)
    let text = doc.textDocument.getText(range)
    if (text) await commands.executeCommand('snippets.editSnippets', text)
  }, { sync: false }))

  subscriptions.push(commands.registerCommand('snippets.editSnippets', async (text?: string) => {
    let buf = await nvim.buffer
    let doc = workspace.getDocument(buf.id)
    if (!doc) {
      window.showMessage('Document not found', 'error')
      return
    }
    let filetype = doc.filetype ? doc.filetype : 'all'
    filetype = filetype.indexOf('.') == -1 ? filetype : filetype.split('.')[0]
    let file = path.join(snippetsDir, `${filetype}.snippets`)
    if (!fs.existsSync(file)) {
      await util.promisify(fs.writeFile)(file, documentation, 'utf8')
    }
    let uri = Uri.file(file).toString()
    await workspace.jumpTo(uri, null, configuration.get<string>('editSnippetsCommand'))
    if (text) {
      await nvim.command('normal! G')
      await nvim.command('normal! 2o')
      let position = await window.getCursorPosition()
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
      window.showMessage('Document not found', 'error')
      return
    }
    let files = await manager.getSnippetFiles(doc.filetype)
    if (!files.length) {
      window.showMessage('No related snippet file found', 'warning')
      return
    }
    let idx = await window.showQuickpick(files, 'choose snippet file:')
    if (idx == -1) return
    let uri = Uri.file(files[idx]).toString()
    await workspace.jumpTo(uri, null, configuration.get<string>('editSnippetsCommand'))
  }))

  subscriptions.push(workspace.registerKeymap(['i'], 'snippets-expand', async () => {
    let bufnr = await nvim.eval('bufnr("%")') as number
    let expanded = await doExpand(bufnr)
    if (!expanded) await fallback()
  }, { silent: true, sync: true, cancel: true }))

  subscriptions.push(workspace.registerKeymap(['i'], 'snippets-expand-jump', async () => {
    let bufnr = await nvim.eval('bufnr("%")') as number
    let expanded = await doExpand(bufnr)
    if (!expanded) {
      let session = snippetManager.getSession(bufnr)
      if (session && session.isActive) {
        await nvim.call('coc#_cancel', [])
        await snippetManager.nextPlaceholder()
        return
      }
      await fallback()
    }
  }, { silent: true, sync: true, cancel: true }))

  subscriptions.push(workspace.registerKeymap(['v'], 'snippets-select', snippetSelect, { silent: true, sync: false, cancel: true }))

  let languageProvider = new LanguageProvider(channel, trace)
  subscriptions.push(languages.registerCompletionItemProvider(
    'snippets-source',
    configuration.get('shortcut', 'S'),
    ['snippets'],
    languageProvider,
    ['$'],
    configuration.get<number>('priority', 90)))
  subscriptions.push(channel)
  subscriptions.push(listManager.registerList(new SnippetsList(workspace.nvim as any, manager, mru)))

  return {
    expandable: async (): Promise<boolean> => {
      let bufnr = await nvim.eval('bufnr("%")') as number
      let edits = await manager.getTriggerSnippets(bufnr)
      return edits && edits.length > 0
    }
  }
}
