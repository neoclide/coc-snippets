import { Document, workspace } from 'coc.nvim'
import { Position, Range } from 'vscode-languageserver-types'
import { Snippet, SnippetEdit } from './types'
import { distinct } from './util'

export interface Config {
  extends: { [index: string]: string[] }
  [key: string]: any
}

export default abstract class BaseProvider {
  constructor(protected config: Config) {
  }

  public abstract init(): Promise<void>
  public abstract async getSnippets(): Promise<Snippet[]>
  public abstract async getSnippetFiles(): Promise<string[]>
  public abstract getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]>
  public abstract resolveSnippetBody(snippet: Snippet, range: Range, line: string): Promise<string>

  public async checkContext(_context: string): Promise<any> {
    return true
  }

  public async getFiletypes(): Promise<string[]> {
    let filetype = await workspace.nvim.eval('&filetype') as string
    let extend = this.config.extends ? this.config.extends[filetype] : null
    let filetypes = filetype.split('.')
    if (extend && extend.length) {
      filetypes = extend.concat(filetypes)
    }
    if (filetype == 'javascript.jsx') filetypes.push('javascriptreact')
    if (filetype == 'typescript.jsx' || filetype == 'typescript.tsx') filetypes.push('typescriptreact')
    let map = await workspace.nvim.getVar('coc_filetype_map') as { [key: string]: string }
    if (map[filetype]) {
      filetypes.push(map[filetype])
    }
    filetypes.reverse()
    return distinct(filetypes)
  }
}
