import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { clearExtensionState, clearFolderState } from '../src/util'
import { waitProviderInit } from './helper'

describe('textmate provider lifecycle', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('clears state of an unloaded extension so it can be reloaded', () => {
    const definitions: Map<string, Array<{ filepath: string }>> = new Map()
    definitions.set('ext1', [{ filepath: '/ext/js.json' }])
    const loadedFiles = new Set(['/ext/js.json', '/ws/.vscode/a.code-snippets'])
    const loadedSnippets = [
      { filepath: '/ext/js.json', extensionId: 'ext1' },
      { filepath: '/ws/.vscode/a.code-snippets' }
    ]
    const res = clearExtensionState(definitions, loadedFiles, loadedSnippets, 'ext1')
    assert.equal(definitions.has('ext1'), false)
    assert.equal(loadedFiles.has('/ext/js.json'), false)
    assert.equal(loadedFiles.has('/ws/.vscode/a.code-snippets'), true)
    assert.deepEqual(res, [{ filepath: '/ws/.vscode/a.code-snippets' }])
  })

  it('clears state of a removed workspace folder so it can be re-added', () => {
    const loadedFiles = new Set(['/ws/.vscode/a.code-snippets', '/other/b.code-snippets'])
    const loadedRoots = new Set(['/ws/.vscode', '/keep/.vscode'])
    const loadedSnippets = [
      { filepath: '/ws/.vscode/a.code-snippets' },
      { filepath: '/other/b.code-snippets' }
    ]
    const res = clearFolderState(loadedFiles, loadedRoots, loadedSnippets, '/ws')
    assert.equal(loadedRoots.has('/ws/.vscode'), false)
    assert.equal(loadedRoots.has('/keep/.vscode'), true)
    assert.equal(loadedFiles.has('/ws/.vscode/a.code-snippets'), false)
    assert.equal(loadedFiles.has('/other/b.code-snippets'), true)
    assert.deepEqual(res, [{ filepath: '/other/b.code-snippets' }])
  })
})
