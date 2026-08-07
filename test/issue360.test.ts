import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { commands, snippetManager, workspace } from 'coc.nvim'
import fs from 'node:fs'
import path from 'node:path'
import { openBuffer, waitFor, waitProviderInit } from './helper'

const fixturesDir = path.resolve(process.cwd(), 'test', 'fixtures')

describe('snippet session survives typing', () => {
  let bufnr: number

  before(async () => {
    let nvim = workspace.nvim
    await waitProviderInit()
    await new Promise<void>(resolve => {
      let d = workspace.onDidRuntimePathChange(() => {
        d.dispose()
        resolve()
      })
      void nvim.command(`execute 'set rtp+='.fnameescape('${fixturesDir}')`)
    })
    let doc = await openBuffer()
    bufnr = doc.bufnr
    await nvim.command('setf javascript')
    await waitFor(() => doc.filetype == 'javascript')
    await commands.executeCommand('snippets.addFiletypes', 'javascript')
  })

  it('keeps the session active and jump works after inserting text', async () => {
    let nvim = workspace.nvim
    await nvim.command('call setline(1, "")')
    await nvim.call('feedkeys', ['Afortest', 'in'])
    await nvim.call('coc#rpc#request', ['doKeymap', ['coc-snippets-expand']])
    await waitFor(() => {
      let session = snippetManager.getSession(bufnr)
      return !!session && session.isActive
    })
    assert.equal(await nvim.eval('coc#status()'), 'SNIP')
    // type a character at the cursor inside the snippet, like a user who
    // selects a completion item and keeps typing
    await nvim.call('feedkeys', ['x', 'in'])
    await waitFor(() => {
      let session = snippetManager.getSession(bufnr)
      return !!session && session.isActive
    })
    assert.equal(await nvim.eval('coc#status()'), 'SNIP')
    await nvim.call('coc#rpc#request', ['doKeymap', ['coc-snippets-expand-jump']])
    await waitFor(async () => {
      let pos = await nvim.eval('[line("."), col(".")]') as [number, number]
      return pos[0] == 3
    })
  })
})
