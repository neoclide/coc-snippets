import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { window } from 'coc.nvim'
import { MassCodeProvider } from '../src/massCodeProvider'
import { waitProviderInit } from './helper'

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
