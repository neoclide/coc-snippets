import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { MassCodeProvider } from '../src/massCodeProvider'
import { waitProviderInit } from './helper'

describe('massCode snippet loading', () => {
  let originalRequest: typeof http.request
  const items = [
    {
      isDeleted: false,
      isFavorites: false,
      folderId: '1',
      description: '',
      name: 'hello',
      content: [{ label: 'Fragment 1', language: 'javascript', value: 'console.log(\'hi\')' }],
      id: '1',
      createdAt: 0,
      updatedAt: 0
    },
    {
      isDeleted: false,
      isFavorites: false,
      folderId: '2',
      description: '',
      name: 'greet',
      content: [{ label: 'Fragment 1', language: 'typescript', value: 'greet()' }],
      id: '2',
      createdAt: 0,
      updatedAt: 0
    },
    {
      isDeleted: true,
      isFavorites: false,
      folderId: '3',
      description: '',
      name: 'gone',
      content: [{ label: 'Fragment 1', language: 'javascript', value: 'deleted' }],
      id: '3',
      createdAt: 0,
      updatedAt: 0
    }
  ]

  before(async () => {
    await waitProviderInit()
    originalRequest = http.request
    http.request = ((_options: http.RequestOptions, callback?: (res: any) => void) => {
      const res = new EventEmitter() as any
      res.statusCode = 200
      process.nextTick(() => {
        callback?.(res)
        res.emit('data', Buffer.from(JSON.stringify(items)))
        res.emit('end')
      })
      return {
        write: () => {},
        on: () => {},
        end: () => {}
      } as any
    }) as any
  })

  after(() => {
    http.request = originalRequest
  })

  it('loads snippets from the massCode API filtered by filetype', async () => {
    const channel = { appendLine: () => {} } as any
    const config = { host: 'localhost', port: 3033, extends: {}, excludes: [], trace: false } as any
    const provider = new MassCodeProvider(channel, config)
    await provider.init()
    const javascript = provider.getSnippets('javascript')
    assert.equal(javascript.length, 1)
    assert.equal(javascript[0].prefix, 'hello')
    assert.equal(javascript[0].body, 'console.log(\'hi\')')
    assert.equal(javascript[0].filetype, 'javascript')
    assert.equal(provider.getSnippets('typescript').some(s => s.prefix == 'greet'), true)
    // Deleted snippets must not be loaded.
    assert.equal(provider.getSnippets('javascript').some(s => s.prefix == 'gone'), false)
    const files = await provider.getSnippetFiles('javascript')
    assert.deepEqual(files, ['1'])
  })
})
