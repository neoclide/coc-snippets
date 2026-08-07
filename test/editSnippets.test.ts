import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { commands, window, workspace } from 'coc.nvim'
import { openBuffer, waitFor } from './helper'

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
