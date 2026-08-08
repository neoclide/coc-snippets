import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commands, extensions, window, workspace } from 'coc.nvim'
import { openBuffer, waitFor, waitProviderInit } from './helper'

describe('textmate snippet loading', () => {
  let dir: string

  before(async () => {
    await waitProviderInit()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-snippets-textmate-'))
    fs.mkdirSync(path.join(dir, 'snippets'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'textmate-loading-fixture',
      version: '1.0.0',
      main: 'index.js',
      engines: {
        coc: '^0.0.82'
      },
      activationEvents: ['*'],
      contributes: {
        snippets: [{
          language: 'javascript',
          path: './snippets/javascript.json'
        }]
      }
    }), 'utf8')
    fs.writeFileSync(path.join(dir, 'index.js'), 'exports.activate = () => {}\n', 'utf8')
    fs.writeFileSync(path.join(dir, 'snippets', 'javascript.json'), JSON.stringify({
      'Log to console': {
        prefix: 'clog',
        body: 'console.log(\'$1\')',
        description: 'Log to console'
      }
    }), 'utf8')
  })

  after(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('loads extension contributed snippets of the current language', async () => {
    let doc = await openBuffer()
    await workspace.nvim.command('setf javascript')
    await waitFor(() => doc.filetype == 'javascript')
    // Load the fixture extension from runtimepath like a normal extension,
    // the textmate provider picks up its contributes.snippets.
    await new Promise<void>(resolve => {
      let disposable = extensions.onDidLoadExtension(extension => {
        if (extension.packageJSON?.name == 'textmate-loading-fixture') {
          disposable.dispose()
          resolve()
        }
      })
      void workspace.nvim.command(`execute 'set rtp+='.fnameescape('${dir}')`)
    })
    await commands.executeCommand('snippets.addFiletypes', 'javascript')
    // The snippet file is now part of the completion source, verify it
    // through the openSnippetFiles command.
    let filesShown: string[] | undefined
    let original = window.showQuickPick
    window.showQuickPick = (async (files: string[]) => {
      filesShown = files
      return files.find(f => f.endsWith('javascript.json'))
    }) as any
    try {
      // addFiletypes loads snippets in the background, retry the command
      // until the textmate provider finished loading the fixture file.
      await waitFor(async () => {
        await commands.executeCommand('snippets.openSnippetFiles')
        return filesShown?.some(f => f.endsWith(path.join('snippets', 'javascript.json'))) === true
      })
      assert.ok(filesShown.some(f => f.endsWith(path.join('snippets', 'javascript.json'))),
        `javascript.json missing from: ${JSON.stringify(filesShown)}`)
    } finally {
      window.showQuickPick = original
    }
  })
})
