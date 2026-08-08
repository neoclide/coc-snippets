import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { commands, window, workspace } from 'coc.nvim'
import path from 'node:path'
import { openBuffer, waitFor, waitProviderInit } from './helper'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures')

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
