import { commands, Disposable, events, ExtensionContext, languages, listManager, Position, Range, snippetManager, TextEdit, Uri, window, workspace } from 'coc.nvim'
import merge from 'merge'
import path from 'path'
import { registerLanguageProvider } from './languages'
import SnippetsList from './list/snippet'
import { ProviderManager } from './provider'
import { SnipmateProvider } from './snipmateProvider'
import { TextmateProvider } from './textmateProvider'
import { MassCodeProvider } from './massCodeProvider'
import { SnippetEditWithSource, UltiSnippetOption, UltiSnipsConfig } from './types'
import { UltiSnippetsProvider, getSnippetsDirectory } from './ultisnipsProvider'
import { sameFile, waitDocument } from './util'

interface API {
  expandable: () => Promise<boolean>
}


async function insertSnippetEdit(edit: SnippetEditWithSource) {
  let ultisnips = edit.source == 'ultisnips' || edit.source == 'snipmate'
  let option: UltiSnippetOption
  if (ultisnips) {
    option = {
      regex: edit.regex,
      context: edit.context
    }
  }
  await commands.executeCommand('editor.action.insertSnippet', TextEdit.replace(edit.range, edit.newText), option)
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
  // let mru = workspace.createMru('snippets-mru')
  const channel = window.createOutputChannel('snippets')
  subscriptions.push(channel)
  const manager = new ProviderManager(channel, subscriptions)

  enableSnippetsFiletype(subscriptions)
  let excludes = configuration.get<string[]>('excludePatterns', [])
  if (!Array.isArray(excludes)) excludes = []
  excludes = excludes.map(p => workspace.expand(p))
  if (configuration.get<boolean>('ultisnips.enable', true)) {
    const snippetsDir = await getSnippetsDirectory(configuration)
    let config = configuration.get<any>('ultisnips', {})
    let c = merge.recursive(true, config, {
      excludes,
      extends: merge.recursive(true, {}, filetypeExtends)
    } as UltiSnipsConfig)
    c.directories = c.directories ? c.directories.slice() : []
    if (Array.isArray(c.directories)
      && snippetsDir
      && c.directories.findIndex(dir => sameFile(dir, snippetsDir)) == -1) {
      c.directories.push(snippetsDir)
    }
    let provider = new UltiSnippetsProvider(channel, c, context)
    manager.regist(provider, 'ultisnips')

    subscriptions.push(commands.registerCommand('snippets.editSnippets', provider.editSnippets))
  }

  if (configuration.loadFromExtensions || configuration.textmateSnippetsRoots?.length > 0) {
    const config = {
      loadFromExtensions: configuration.get<boolean>('loadFromExtensions', true),
      snippetsRoots: configuration.get<string[]>('textmateSnippetsRoots', []),
      projectSnippets: configuration.get<boolean>('loadVSCodeProjectSnippets', true),
      extends: merge.recursive(true, {}, filetypeExtends),
      trace: trace == 'verbose',
      excludes
    }
    let provider = new TextmateProvider(channel, config, subscriptions)
    manager.regist(provider, 'snippets')
  }

  if (configuration.get<boolean>('snipmate.enable', true)) {
    let config = {
      author: configuration.get<string>('snipmate.author', ''),
      extends: merge.recursive(true, {}, filetypeExtends),
      trace: configuration.get<boolean>('snipmate.trace', false),
      excludes
    }
    let provider = new SnipmateProvider(channel, config, subscriptions)
    manager.regist(provider, 'snipmate')
  }

  if (configuration.get<boolean>('massCode.enable', false)) {
    let config = {
      host: configuration.get<string>('massCode.host', 'localhost'),
      port: configuration.get<number>('massCode.port', 3033),
      extends: merge.recursive(true, {}, filetypeExtends),
      trace: configuration.get<boolean>('massCode.trace', false),
      excludes
    }

    let provider = new MassCodeProvider(channel, config)

    manager.regist(provider, 'massCode')

    subscriptions.push(commands.registerCommand('snippets.editMassCodeSnippets', provider.createSnippet.bind(provider)))
  }

  if (configuration.get<boolean>('autoTrigger', true)) {
    events.on('TextInsert', async (bufnr, info) => {
      let changedtick = info.changedtick
      let doc = workspace.getDocument(bufnr)
      if (!doc || doc.isCommandLine || !doc.attached) return
      let res = await waitDocument(doc, changedtick)
      if (!res) return
      changedtick = doc.changedtick
      let position = Position.create(info.lnum - 1, info.pre.length)
      let edits = await manager.getTriggerSnippets(bufnr, true, position)
      if (doc.changedtick != changedtick) return
      if (edits.length == 0) return
      if (edits.length > 1) {
        channel.appendLine(`Multiple snippets found on auto trigger: ${JSON.stringify(edits, null, 2)}`)
        window.showMessage('Multiple snippets found on auto trigger', 'warning')
        await commands.executeCommand('workspace.showOutput', 'snippets')
      }
      await insertSnippetEdit(edits[0])
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
      await insertSnippetEdit(edits[0])
    } else {
      let idx = await window.showQuickpick(edits.map(e => e.description || e.prefix), 'choose snippet:')
      if (idx == -1) return
      await insertSnippetEdit(edits[idx])
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

  subscriptions.push(commands.registerCommand('snippets.openOutput', () => {
    void window.showOutputChannel('snippets', false)
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
  registerLanguageProvider(subscriptions, channel)
  subscriptions.push(listManager.registerList(new SnippetsList(workspace.nvim as any, manager)))

  return {
    expandable: async (): Promise<boolean> => {
      let bufnr = await nvim.eval('bufnr("%")') as number
      let edits = await manager.getTriggerSnippets(bufnr)
      return edits && edits.length > 0
    }
  }
}
