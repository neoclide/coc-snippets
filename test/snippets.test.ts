import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { commands, Document, workspace } from 'coc.nvim'
import fs from 'node:fs'
import path from 'node:path'
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
