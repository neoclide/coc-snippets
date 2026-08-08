import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { commands, Disposable, window, workspace } from 'coc.nvim'
import path from 'node:path'
import extension from '../lib/index.js'
import { openBuffer, waitFor, waitProviderInit } from './helper'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures')

describe('extension activation', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('exports the activation API', () => {
    assert.equal(typeof extension.activate, 'function')
    assert.equal(typeof extension.checkBufferVariable, 'function')
    assert.equal(typeof extension.enableSnippetsFiletype, 'function')
  })

  it('communicates with the editor through RPC', async () => {
    assert.equal(await workspace.nvim.eval('1 + 1'), 2)
  })

  it('registers commands', async () => {
    assert.equal(commands.has('snippets.addFiletypes'), true)
    assert.equal(commands.has('snippets.openOutput'), true)
    assert.equal(commands.has('snippets.openSnippetFiles'), true)
    assert.equal(commands.has('snippets.editSnippets'), true)
  })

  it('snippets.addFiletypes sets the buffer variable', async () => {
    let doc = await openBuffer()
    await commands.executeCommand('snippets.addFiletypes', 'typescript')
    await waitFor(async () => {
      let arr = await doc.buffer.getVar('coc_snippets_filetypes') as string[]
      return Array.isArray(arr) && arr.includes('typescript')
    })
  })
})

describe('buffer filetype handling', () => {
  let subscriptions: Disposable[] = []

  before(async () => {
    await waitProviderInit()
    // The coc-test harness loads the extension after coc.nvim already fired
    // the `ready` event, so the ready hook inside activate never runs.
    // Invoke the startup behavior explicitly, same as activate would.
    extension.enableSnippetsFiletype(subscriptions)
  })

  after(() => {
    for (let disposable of subscriptions) {
      disposable.dispose()
    }
  })

  it('sets coc_snippets_filetypes when no snippets_filetypes variable exists', async () => {
    let doc = await openBuffer()
    extension.checkBufferVariable(doc)
    assert.deepEqual(await doc.buffer.getVar('coc_snippets_filetypes'), [])
  })

  it('addFiletypes command does not duplicate filetypes', async () => {
    let doc = await openBuffer()
    await commands.executeCommand('snippets.addFiletypes', 'python')
    await commands.executeCommand('snippets.addFiletypes', 'python')
    await waitFor(async () => {
      let arr = await doc.buffer.getVar('coc_snippets_filetypes') as string[]
      return Array.isArray(arr) && arr.filter(x => x == 'python').length == 1
    })
  })

  it('sets the filetype of .snippets buffers', async () => {
    let doc = await openBuffer('snippet.snippets')
    await waitFor(() => doc.filetype == 'snippets')
  })
})

describe('snippets.editSnippets', () => {
  let originalPick: any

  before(() => {
    originalPick = window.showQuickPick
  })

  after(() => {
    window.showQuickPick = originalPick
  })

  async function markdownBuffer(): Promise<void> {
    let doc = await openBuffer()
    await workspace.nvim.command('setf markdown')
    await waitFor(() => doc.filetype == 'markdown')
  }

  it('opens the snippet file of the current filetype directly', async () => {
    await markdownBuffer()
    await commands.executeCommand('snippets.editSnippets')
    await waitFor(async () => {
      return await workspace.nvim.eval('expand("%:t")') == 'markdown.snippets'
    })
  })

  it('lists all related snippet files when additional filetypes exist', async () => {
    await markdownBuffer()
    await commands.executeCommand('snippets.addFiletypes', 'tex', 'mermaid')
    let items: string[] = []
    window.showQuickPick = (async (list: string[]) => {
      items = list
      return list[1]
    }) as any
    await commands.executeCommand('snippets.editSnippets')
    assert.equal(items.length, 3)
    assert.ok(items[0].endsWith('markdown.snippets'))
    assert.ok(items[1].endsWith('tex.snippets'))
    assert.ok(items[2].endsWith('mermaid.snippets'))
    await waitFor(async () => {
      return await workspace.nvim.eval('expand("%:t")') == 'tex.snippets'
    })
  })

  it('does not jump when the picker is cancelled', async () => {
    await markdownBuffer()
    await commands.executeCommand('snippets.addFiletypes', 'tex')
    let before: string
    window.showQuickPick = (async (list: string[]) => {
      before = await workspace.nvim.eval('expand("%:t")') as string
      return null
    }) as any
    await commands.executeCommand('snippets.editSnippets')
    assert.equal(await workspace.nvim.eval('expand("%:t")'), before)
  })
})

describe('registered commands', () => {
  before(async () => {
    await waitProviderInit()
    // Register the fixture directory on runtimepath, so the ultisnips
    // provider can load javascript.snippets from it.
    await new Promise<void>(resolve => {
      let disposable = workspace.onDidRuntimePathChange(() => {
        disposable.dispose()
        resolve()
      })
      void workspace.nvim.command(`execute 'set rtp+='.fnameescape('${fixturesDir}')`)
    })
  })

  it('registers the contributed commands', () => {
    for (let id of ['snippets.addFiletypes', 'snippets.editSnippets', 'snippets.openSnippetFiles', 'snippets.openOutput']) {
      assert.equal(commands.has(id), true, `command ${id} not registered`)
    }
  })

  it('registers the massCode command only when massCode is enabled', () => {
    let enabled = workspace.getConfiguration('snippets', null).get<boolean>('massCode.enable', false)
    assert.equal(commands.has('snippets.editMassCodeSnippets'), enabled)
  })

  it('snippets.openOutput shows the snippets output channel', async () => {
    let shown: string
    let original = window.showOutputChannel
    window.showOutputChannel = ((name: string) => {
      shown = name
    }) as any
    try {
      await commands.executeCommand('snippets.openOutput')
      assert.equal(shown, 'snippets')
    } finally {
      window.showOutputChannel = original
    }
  })

  it('snippets.addFiletypes prompts for the filetype when no argument is given', async () => {
    let doc = await openBuffer()
    let original = window.requestInput
    window.requestInput = async () => 'python' as any
    try {
      await commands.executeCommand('snippets.addFiletypes')
      await waitFor(async () => {
        let arr = await doc.buffer.getVar('coc_snippets_filetypes') as string[]
        return Array.isArray(arr) && arr.includes('python')
      })
    } finally {
      window.requestInput = original
    }
  })

  it('snippets.openSnippetFiles jumps to a snippet file of the current filetype', async () => {
    let nvim = workspace.nvim
    let doc = await openBuffer()
    await nvim.command('setf javascript')
    await waitFor(() => doc.filetype == 'javascript')
    let picked: string
    let originalPick = window.showQuickPick
    let originalWarn = window.showWarningMessage
    // The addFiletypes command loads snippets in the background, retry the
    // command until the provider finished loading the fixture file.
    window.showWarningMessage = (async () => undefined) as any
    window.showQuickPick = (async (files: string[]) => {
      picked = files.find(f => f.endsWith('javascript.snippets'))
      return picked
    }) as any
    try {
      await commands.executeCommand('snippets.addFiletypes', 'javascript')
      await waitFor(async () => {
        await commands.executeCommand('snippets.openSnippetFiles')
        return picked != null
      })
      assert.ok(picked.endsWith('javascript.snippets'), `unexpected pick: ${picked}`)
      await waitFor(async () => {
        return await nvim.eval('expand("%:t")') == 'javascript.snippets'
      })
    } finally {
      window.showQuickPick = originalPick
      window.showWarningMessage = originalWarn
    }
  })

  it('snippets.openSnippetFiles does not jump when the picker is cancelled', async () => {
    let nvim = workspace.nvim
    let doc = await openBuffer()
    await nvim.command('setf javascript')
    await waitFor(() => doc.filetype == 'javascript')
    let filesShown: string[] | undefined
    let original = window.showQuickPick
    window.showQuickPick = (async (files: string[]) => {
      filesShown = files
      return undefined
    }) as any
    try {
      let bufnr = await nvim.eval('bufnr("%")')
      await commands.executeCommand('snippets.addFiletypes', 'javascript')
      // Retry the command until the provider finished loading the fixture.
      await waitFor(async () => {
        await commands.executeCommand('snippets.openSnippetFiles')
        return Array.isArray(filesShown) && filesShown.length > 0
      })
      assert.equal(await nvim.eval('bufnr("%")'), bufnr)
    } finally {
      window.showQuickPick = original
    }
  })
})
