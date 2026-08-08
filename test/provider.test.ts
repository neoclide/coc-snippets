import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { window } from 'coc.nvim'
import { MassCodeProvider } from '../src/massCodeProvider'
import { Snippet, TriggerKind } from '../src/types'
import { UltiSnippetsProvider } from '../src/ultisnipsProvider'
import { clearExtensionState, clearFolderState } from '../src/util'
import { waitProviderInit } from './helper'

function makeSnippet(prefix: string, priority: number, body: string): Snippet {
  return {
    filepath: '/tmp/all.snippets',
    lnum: 1,
    body,
    prefix,
    description: body,
    triggerKind: TriggerKind.SpaceBefore,
    filetype: 'all',
    priority
  }
}

describe('ultisnips snippet dedup', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('keeps the higher priority snippet for a duplicated prefix', () => {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, directories: [] } as any
    const context = { subscriptions: [], asAbsolutePath: () => '' } as any
    const provider = new UltiSnippetsProvider(channel, config, context)
    ;(provider as any).snippetFiles = [
      { filepath: '/plugin/all.snippets', filetype: 'all', clearsnippets: null, snippets: [makeSnippet('foo', 10, 'low-priority-body')] },
      { filepath: '/user/all.snippets', filetype: 'all', clearsnippets: null, snippets: [makeSnippet('foo', 50, 'high-priority-body')] }
    ]
    const res = provider.getSnippets('javascript')
    assert.equal(res.length, 1)
    assert.equal(res[0].body, 'high-priority-body')
    assert.equal(res[0].priority, 50)
  })

  it('keeps the first snippet when priorities are equal', () => {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, directories: [] } as any
    const context = { subscriptions: [], asAbsolutePath: () => '' } as any
    const provider = new UltiSnippetsProvider(channel, config, context)
    ;(provider as any).snippetFiles = [
      { filepath: '/a/all.snippets', filetype: 'all', clearsnippets: null, snippets: [makeSnippet('bar', 20, 'first-body')] },
      { filepath: '/b/all.snippets', filetype: 'all', clearsnippets: null, snippets: [makeSnippet('bar', 20, 'second-body')] }
    ]
    const res = provider.getSnippets('javascript')
    assert.equal(res.length, 1)
    assert.equal(res[0].body, 'first-body')
  })
})

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

describe('massCode createSnippet', () => {
  let originalRequest: typeof http.request
  let requestBodies: string[]

  before(async () => {
    await waitProviderInit()
    originalRequest = http.request
    requestBodies = []
    http.request = ((_options: http.RequestOptions, callback?: (res: any) => void) => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      process.nextTick(() => {
        callback?.(res)
        res.emit('data', Buffer.from('{}'))
        res.emit('end')
      })
      return {
        write: (body: string) => {
          requestBodies.push(body)
        },
        on: () => {},
        end: () => {}
      } as any
    }) as any
  })

  after(() => {
    http.request = originalRequest
  })

  it('creates a snippet when the command is invoked without text', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { host: 'localhost', port: 3033, extends: {}, excludes: [], trace: false } as any
    const provider = new MassCodeProvider(channel, config)
    ;(provider as any).init = async () => {}
    const originalRequestInput = window.requestInput
    window.requestInput = async () => 'mass-test' as any
    try {
      await provider.createSnippet()
      assert.ok(requestBodies.length > 0)
      const payload = JSON.parse(requestBodies[0])
      assert.equal(payload.name, 'mass-test')
      assert.equal(payload.content[0].value, '')
      assert.equal(payload.id, '0')
    } finally {
      window.requestInput = originalRequestInput
    }
  })
})
