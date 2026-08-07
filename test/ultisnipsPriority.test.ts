import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import { UltiSnippetsProvider } from '../src/ultisnipsProvider'
import { Snippet, TriggerKind } from '../src/types'
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
