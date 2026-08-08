import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspace } from 'coc.nvim'
import UltiSnipsParser from '../src/ultisnipsParser'
import { UltiSnippetsProvider } from '../src/ultisnipsProvider'
import { waitProviderInit } from './helper'

describe('ultisnips snippet loading', () => {
  let dir: string

  before(async () => {
    await waitProviderInit()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-snippets-ultisnips-'))
    fs.writeFileSync(path.join(dir, 'javascript.snippets'), [
      'snippet clog "log to console" b',
      'console.log(\'$1\')',
      'endsnippet',
      '',
      'snippet fori "for loop"',
      'for (${1:i} = 0; $1 < ${2:n}; $1++) {',
      '\t$0',
      '}',
      'endsnippet'
    ].join('\n'), 'utf8')
    fs.writeFileSync(path.join(dir, 'all.snippets'), [
      'snippet author "author name"',
      'Qiming Zhao',
      'endsnippet'
    ].join('\n'), 'utf8')
  })

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function makeProvider(): UltiSnippetsProvider {
    const channel = { appendLine: () => {} } as any
    const config = { extends: {}, excludes: [], trace: false, directories: [dir] } as any
    const context = { subscriptions: [], asAbsolutePath: () => '' } as any
    const provider = new UltiSnippetsProvider(channel, config, context)
    ;(provider as any).parser = new UltiSnipsParser(channel, false)
    return provider
  }

  it('loads snippets from the configured directories', async () => {
    const provider = makeProvider()
    // Keep only items from the fixture directory so the user's real
    // runtimepath (e.g. ~/.config/nvim/UltiSnips) cannot affect the result.
    ;(provider as any).fileItems = (await provider.loadAllFileItems(workspace.env.runtimepath))
      .filter((i: any) => i.directory == dir)
    await provider.loadSnippetsByFiletype('javascript')
    const snippets = provider.getSnippets('javascript')
    assert.deepEqual(snippets.map(s => s.prefix).sort(), ['author', 'clog', 'fori'])
    assert.equal(snippets.find(s => s.prefix == 'clog').body, 'console.log(\'$1\')')
    assert.equal(snippets.find(s => s.prefix == 'fori').body, 'for (${1:i} = 0; $1 < ${2:n}; $1++) {\n\t$0\n}')
    assert.equal(snippets.find(s => s.prefix == 'author').filetype, 'all')
    const files = await provider.getSnippetFiles('javascript')
    assert.deepEqual(files.map(f => path.basename(f)).sort(), ['all.snippets', 'javascript.snippets'])
  })

  it('loads all.snippets for every filetype', async () => {
    const provider = makeProvider()
    ;(provider as any).fileItems = (await provider.loadAllFileItems(workspace.env.runtimepath))
      .filter((i: any) => i.directory == dir)
    await provider.loadSnippetsByFiletype('ruby')
    const snippets = provider.getSnippets('ruby')
    assert.equal(snippets.length, 1)
    assert.equal(snippets[0].prefix, 'author')
    const files = await provider.getSnippetFiles('ruby')
    assert.deepEqual(files.map(f => path.basename(f)), ['all.snippets'])
  })
})
