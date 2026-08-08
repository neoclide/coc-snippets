import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { workspace } from 'coc.nvim'
import { SnipmateProvider } from '../src/snipmateProvider'
import { waitProviderInit } from './helper'

describe('snipmate snippet loading', () => {
  before(async () => {
    await waitProviderInit()
  })

  it('loads all snippet files of the same filetype', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-snippets-snipmate-'))
    try {
      const names = ['a', 'b', 'c']
      const filepaths = names.map(name => {
        const filepath = path.join(dir, name + '.snippets')
        fs.writeFileSync(filepath, `snippet foo${name}\n\tbody of ${name}\n`, 'utf8')
        return filepath
      })
      const channel = { appendLine: () => {} } as any
      const config = { extends: {}, excludes: [], trace: false, author: '' } as any
      const provider = new SnipmateProvider(channel, config, [])
      ;(provider as any).fileItems = filepaths.map(filepath => ({
        filepath,
        directory: dir,
        filetype: 'javascript'
      }))
      await provider.loadSnippetsByFiletype('javascript')
      const loaded = (provider as any).snippetFiles.map((s: any) => path.basename(s.filepath)).sort()
      assert.deepEqual(loaded, ['a.snippets', 'b.snippets', 'c.snippets'])
      assert.equal((provider as any).fileItems.length, 0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('discovers and loads snippet files from runtimepath', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-snippets-snipmate-rtp-'))
    try {
      const snippetsDir = path.join(dir, 'snippets')
      fs.mkdirSync(snippetsDir, { recursive: true })
      fs.writeFileSync(path.join(snippetsDir, 'javascript.snippets'), [
        'extends python',
        '',
        'snippet foo "foo body"',
        '\tfoo body',
        '',
        'snippet bar "bar body"',
        '\tbar body'
      ].join('\n'), 'utf8')
      fs.writeFileSync(path.join(snippetsDir, 'python.snippets'), [
        'snippet pybody "python body"',
        '\tpython body'
      ].join('\n'), 'utf8')
      // Add the directory to runtimepath and wait until coc reported the
      // change, so env.runtimepath includes it when init scans for snippets.
      await new Promise<void>(resolve => {
        let disposable = workspace.onDidRuntimePathChange(() => {
          disposable.dispose()
          resolve()
        })
        void workspace.nvim.command(`execute 'set rtp+='.fnameescape('${dir}')`)
      })
      const channel = { appendLine: () => {} } as any
      const config = { extends: {}, excludes: [], trace: false, author: '' } as any
      const provider = new SnipmateProvider(channel, config, [])
      await provider.init()
      // init also discovers snippet files from the user's real runtimepath
      // (e.g. ~/.config/nvim/snippets), keep only the fixture directory.
      assert.ok((provider as any).fileItems.some((i: any) => i.directory.startsWith(dir)))
      ;(provider as any).fileItems = (provider as any).fileItems.filter((i: any) => i.directory.startsWith(dir))
      await provider.loadSnippetsByFiletype('javascript')
      const snippets = provider.getSnippets('javascript')
      assert.deepEqual(snippets.map(s => s.prefix).sort(), ['bar', 'foo', 'pybody'])
      assert.equal(snippets.find(s => s.prefix == 'foo').body, 'foo body')
      assert.equal(snippets.find(s => s.prefix == 'pybody').body, 'python body')
      const files = await provider.getSnippetFiles('javascript')
      assert.deepEqual(files.map(f => path.basename(f)).sort(), ['javascript.snippets', 'python.snippets'])
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
