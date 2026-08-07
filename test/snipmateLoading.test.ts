import assert from 'node:assert/strict'
import { before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
})
