import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { commands, workspace } from 'coc.nvim'
import extension from '../lib/index.js'
import { openBuffer, waitFor, waitProviderInit } from './helper'

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
