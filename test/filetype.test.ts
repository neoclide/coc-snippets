import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { commands, Disposable, workspace } from 'coc.nvim'
import extension from '../lib/index.js'
import { openBuffer, waitFor, waitProviderInit } from './helper'

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
