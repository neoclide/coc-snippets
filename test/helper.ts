import { Document, window, workspace } from 'coc.nvim'
import path from 'node:path'

export async function waitFor(fn: () => boolean | Promise<boolean>, timeout = 10000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`waitFor timed out after ${timeout}ms`)
}

/**
 * Open a new buffer and wait until coc attached a document to it.
 * The document delivered by `onDidOpenTextDocument` can be a transient object
 * without an attached buffer, so poll the workspace document by bufnr instead.
 */
export async function openBuffer(name?: string): Promise<Document> {
  await workspace.nvim.command(name ? `edit ${name}` : 'enew!')
  let bufnr = await currentBufnr()
  await waitFor(() => {
    let doc = workspace.getDocument(bufnr)
    if (!doc || !doc.buffer) return false
    if (name) return doc.uri.includes(path.basename(name))
    return true
  })
  return workspace.getDocument(bufnr)
}

export async function currentBufnr(): Promise<number> {
  return await workspace.nvim.eval('bufnr("%")') as number
}

/**
 * Wait until the extension's provider manager finished initializing.
 *
 * Provider inits run in the background during `activate`. The manager
 * registers its editor listeners only after all of them complete, so a
 * window change proves the listeners (including the ultisnips runtimepath
 * listener) are registered and the slow python check has settled.
 */
export async function waitProviderInit(): Promise<void> {
  let nvim = workspace.nvim
  await nvim.call('pyxeval', ['1']).catch(() => {})
  await new Promise<void>((resolve, reject) => {
    let disposable = window.onDidChangeActiveTextEditor(() => {
      disposable.dispose()
      resolve()
    })
    void nvim.command('vsplit').catch(reject)
  })
  await nvim.command('only')
}
