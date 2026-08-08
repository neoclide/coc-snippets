import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { commands, Document, extensions, window, workspace } from 'coc.nvim'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { MassCodeProvider } from '../src/massCodeProvider'
import { SnipmateProvider } from '../src/snipmateProvider'
import UltiSnipsParser from '../src/ultisnipsParser'
import { UltiSnippetsProvider } from '../src/ultisnipsProvider'
import { openBuffer, waitFor, waitProviderInit } from './helper'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures')

describe('snippet loading and expansion', () => {
  let doc: Document

  before(async () => {
    assert.equal(fs.existsSync(path.join(fixturesDir, 'UltiSnips', 'javascript.snippets')), true,
      `fixture not found in ${fixturesDir}`)
    let nvim = workspace.nvim
    // Wait until the provider manager finished initializing, so the
    // runtimepath listener below is registered and never misses the change.
    await waitProviderInit()
    // Register the fixture directory on runtimepath and wait until coc reported
    // the change, so the ultisnips provider scans it for snippet files.
    await new Promise<void>(resolve => {
      let disposable = workspace.onDidRuntimePathChange(() => {
        disposable.dispose()
        resolve()
      })
      void nvim.command(`execute 'set rtp+='.fnameescape('${fixturesDir}')`)
    })
    doc = await openBuffer()
    await nvim.command('setf javascript')
    await waitFor(() => doc.filetype == 'javascript')
    // The addFiletypes command loads snippets for the filetype through the
    // provider manager, giving us a deterministic point after loading.
    await commands.executeCommand('snippets.addFiletypes', 'javascript')
  })

  it('adds javascript to the buffer filetype variable', async () => {
    await waitFor(async () => {
      let arr = await doc.buffer.getVar('coc_snippets_filetypes') as string[]
      return Array.isArray(arr) && arr.includes('javascript')
    })
  })

  it('expands the fixture snippet through the snippets-expand keymap', async () => {
    let nvim = workspace.nvim
    await nvim.command('call setline(1, "")')
    // Type the snippet trigger like a user would in insert mode, leaving the
    // cursor after the trigger word. feedkeys works on both Vim and Neovim.
    await nvim.call('feedkeys', ['Afortest', 'in'])
    // Invoke the registered <Plug>(coc-snippets-expand) keymap like typing it.
    await nvim.call('coc#rpc#request', ['doKeymap', ['coc-snippets-expand']])
    await waitFor(async () => {
      let line = doc.getline(0)
      return line.startsWith('for (;;)')
    })
  })
})

describe('snipmate snippet loading', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('loads all snippet files of the same filetype', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-snippets-snipmate-'))
    try {
      const names = ['a', 'b', 'c']
      const filepaths = names.map(name => {
        const filepath = path.join(dir, name + '.snippets')
        fs.writeFileSync(filepath, `snippet foo${name}\n\tbody of ${name}\n`, 'utf8')
        return filepath
      })
      const channel = { appendLine: () => {} } as any
      const config = { extends: {}, excludes: [], trace: false, author: '' } as any
      const provider = new SnipmateProvider(channel, config, [])
      ;(provider as any).fileItems = filepaths.map(filepath => ({
        filepath,
        directory: dir,
        filetype: 'javascript'
      }))
      await provider.loadSnippetsByFiletype('javascript')
      const loaded = (provider as any).snippetFiles.map((s: any) => path.basename(s.filepath)).sort()
      assert.deepEqual(loaded, ['a.snippets', 'b.snippets', 'c.snippets'])
      assert.equal((provider as any).fileItems.length, 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discovers and loads snippet files from runtimepath', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-snippets-snipmate-rtp-'))
    try {
      const snippetsDir = path.join(dir, 'snippets')
      fs.mkdirSync(snippetsDir, { recursive: true })
      fs.writeFileSync(path.join(snippetsDir, 'javascript.snippets'), [
        'extends python',
        '',
        'snippet foo "foo body"',
        '\tfoo body',
        '',
        'snippet bar "bar body"',
        '\tbar body'
      ].join('\n'), 'utf8')
      fs.writeFileSync(path.join(snippetsDir, 'python.snippets'), [
        'snippet pybody "python body"',
        '\tpython body'
      ].join('\n'), 'utf8')
      // Add the directory to runtimepath and wait until coc reported the
      // change, so env.runtimepath includes it when init scans for snippets.
      await new Promise<void>(resolve => {
        let disposable = workspace.onDidRuntimePathChange(() => {
          disposable.dispose()
          resolve()
        })
        void workspace.nvim.command(`execute 'set rtp+='.fnameescape('${dir}')`)
      })
      const channel = { appendLine: () => {} } as any
      const config = { extends: {}, excludes: [], trace: false, author: '' } as any
      const provider = new SnipmateProvider(channel, config, [])
      await provider.init()
      // init also discovers snippet files from the user's real runtimepath
      // (e.g. ~/.config/nvim/snippets), keep only the fixture directory.
      assert.ok((provider as any).fileItems.some((i: any) => i.directory.startsWith(dir)))
      ;(provider as any).fileItems = (provider as any).fileItems.filter((i: any) => i.directory.startsWith(dir))
      await provider.loadSnippetsByFiletype('javascript')
      const snippets = provider.getSnippets('javascript')
      assert.deepEqual(snippets.map(s => s.prefix).sort(), ['bar', 'foo', 'pybody'])
      assert.equal(snippets.find(s => s.prefix == 'foo').body, 'foo body')
      assert.equal(snippets.find(s => s.prefix == 'pybody').body, 'python body')
      const files = await provider.getSnippetFiles('javascript')
      assert.deepEqual(files.map(f => path.basename(f)).sort(), ['javascript.snippets', 'python.snippets'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ultisnips snippet loading', () => {
  let dir: string

  before(async () => {
    await waitProviderInit()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-snippets-ultisnips-'))
    fs.writeFileSync(path.join(dir, 'javascript.snippets'), [
      'snippet clog "log to console" b',
      'console.log(\'$1\')',
      'endsnippet',
      '',
      'snippet fori "for loop"',
      'for (${1:i} = 0; $1 < ${2:n}; $1++) {',
      '\t$0',
      '}',
      'endsnippet'
    ].join('\n'), 'utf8')
    fs.writeFileSync(path.join(dir, 'all.snippets'), [
      'snippet author "author name"',
      'Qiming Zhao',
      'endsnippet'
    ].join('\n'), 'utf8')
  })

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function makeProvider(): UltiSnippetsProvider {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, directories: [dir] } as any
    const context = { subscriptions: [], asAbsolutePath: () => '' } as any
    const provider = new UltiSnippetsProvider(channel, config, context)
    ;(provider as any).parser = new UltiSnipsParser(channel, false)
    return provider
  }

  it('loads snippets from the configured directories', async () => {
    const provider = makeProvider()
    // Keep only items from the fixture directory so the user's real
    // runtimepath (e.g. ~/.config/nvim/UltiSnips) cannot affect the result.
    ;(provider as any).fileItems = (await provider.loadAllFileItems(workspace.env.runtimepath))
      .filter((i: any) => i.directory == dir)
    await provider.loadSnippetsByFiletype('javascript')
    const snippets = provider.getSnippets('javascript')
    assert.deepEqual(snippets.map(s => s.prefix).sort(), ['author', 'clog', 'fori'])
    assert.equal(snippets.find(s => s.prefix == 'clog').body, 'console.log(\'$1\')')
    assert.equal(snippets.find(s => s.prefix == 'fori').body, 'for (${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}')
    assert.equal(snippets.find(s => s.prefix == 'author').filetype, 'all')
    const files = await provider.getSnippetFiles('javascript')
    assert.deepEqual(files.map(f => path.basename(f)).sort(), ['all.snippets', 'javascript.snippets'])
  })

  it('loads all.snippets for every filetype', async () => {
    const provider = makeProvider()
    ;(provider as any).fileItems = (await provider.loadAllFileItems(workspace.env.runtimepath))
      .filter((i: any) => i.directory == dir)
    await provider.loadSnippetsByFiletype('ruby')
    const snippets = provider.getSnippets('ruby')
    assert.equal(snippets.length, 1)
    assert.equal(snippets[0].prefix, 'author')
    const files = await provider.getSnippetFiles('ruby')
    assert.deepEqual(files.map(f => path.basename(f)), ['all.snippets'])
  })
})

describe('textmate snippet loading', () => {
  let dir: string

  before(async () => {
    await waitProviderInit()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-snippets-textmate-'))
    fs.mkdirSync(path.join(dir, 'snippets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'textmate-loading-fixture',
      version: '1.0.0',
      main: 'index.js',
      engines: {
        coc: '^0.0.82'
      },
      activationEvents: ['*'],
      contributes: {
        snippets: [{
          language: 'javascript',
          path: './snippets/javascript.json'
        }]
      }
    }), 'utf8')
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.activate = () => {}\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'snippets', 'javascript.json'), JSON.stringify({
      'Log to console': {
        prefix: 'clog',
        body: 'console.log(\'$1\')',
        description: 'Log to console'
      }
    }), 'utf8')
  })

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('loads extension contributed snippets of the current language', async () => {
    let doc = await openBuffer()
    await workspace.nvim.command('setf javascript')
    await waitFor(() => doc.filetype == 'javascript')
    // Load the fixture extension from runtimepath like a normal extension,
    // the textmate provider picks up its contributes.snippets.
    await new Promise<void>(resolve => {
      let disposable = extensions.onDidLoadExtension(extension => {
        if (extension.packageJSON?.name == 'textmate-loading-fixture') {
          disposable.dispose()
          resolve()
        }
      })
      void workspace.nvim.command(`execute 'set rtp+='.fnameescape('${dir}')`)
    })
    await commands.executeCommand('snippets.addFiletypes', 'javascript')
    // The snippet file is now part of the completion source, verify it
    // through the openSnippetFiles command.
    let filesShown: string[] | undefined
    let original = window.showQuickPick
    window.showQuickPick = (async (files: string[]) => {
      filesShown = files
      return files.find(f => f.endsWith('javascript.json'))
    }) as any
    try {
      // addFiletypes loads snippets in the background, retry the command
      // until the textmate provider finished loading the fixture file.
      await waitFor(async () => {
        await commands.executeCommand('snippets.openSnippetFiles')
        return filesShown?.some(f => f.endsWith(path.join('snippets', 'javascript.json'))) === true
      })
      assert.ok(filesShown.some(f => f.endsWith(path.join('snippets', 'javascript.json'))),
        `javascript.json missing from: ${JSON.stringify(filesShown)}`)
    } finally {
      window.showQuickPick = original
    }
  })
})

describe('massCode snippet loading', () => {
  let originalRequest: typeof http.request
  const items = [
    {
      isDeleted: false,
      isFavorites: false,
      folderId: '1',
      description: '',
      name: 'hello',
      content: [{ label: 'Fragment 1', language: 'javascript', value: 'console.log(\'hi\')' }],
      id: '1',
      createdAt: 0,
      updatedAt: 0
    },
    {
      isDeleted: false,
      isFavorites: false,
      folderId: '2',
      description: '',
      name: 'greet',
      content: [{ label: 'Fragment 1', language: 'typescript', value: 'greet()' }],
      id: '2',
      createdAt: 0,
      updatedAt: 0
    },
    {
      isDeleted: true,
      isFavorites: false,
      folderId: '3',
      description: '',
      name: 'gone',
      content: [{ label: 'Fragment 1', language: 'javascript', value: 'deleted' }],
      id: '3',
      createdAt: 0,
      updatedAt: 0
    }
  ]

  before(async () => {
    await waitProviderInit()
    originalRequest = http.request
    http.request = ((_options: http.RequestOptions, callback?: (res: any) => void) => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      process.nextTick(() => {
        callback?.(res)
        res.emit('data', Buffer.from(JSON.stringify(items)))
        res.emit('end')
      })
      return {
        write: () => {},
        on: () => {},
        end: () => {}
      } as any
    }) as any
  })

  after(() => {
    http.request = originalRequest
  })

  it('loads snippets from the massCode API filtered by filetype', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { host: 'localhost', port: 3033, extends: {}, excludes: [], trace: false } as any
    const provider = new MassCodeProvider(channel, config)
    await provider.init()
    const javascript = provider.getSnippets('javascript')
    assert.equal(javascript.length, 1)
    assert.equal(javascript[0].prefix, 'hello')
    assert.equal(javascript[0].body, 'console.log(\'hi\')')
    assert.equal(javascript[0].filetype, 'javascript')
    assert.equal(provider.getSnippets('typescript').some(s => s.prefix == 'greet'), true)
    // Deleted snippets must not be loaded.
    assert.equal(provider.getSnippets('javascript').some(s => s.prefix == 'gone'), false)
    const files = await provider.getSnippetFiles('javascript')
    assert.deepEqual(files, ['1'])
  })
})
