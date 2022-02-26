import { Document, Position, Range, workspace } from 'coc.nvim'
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
  public abstract getSnippets(filetype: string): Promise<Snippet[]>
  public abstract getSnippetFiles(filetype: string): Promise<string[]>
  public abstract getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]>
  public abstract resolveSnippetBody(snippet: Snippet, range: Range, line: string): Promise<string>

  public async checkContext(_context: string): Promise<any> {
    return true
  }

  protected getExtendsFiletypes(filetype: string, exists: Set<string> = new Set()): string[] {
    if (exists.has(filetype)) return []
    let extend = this.config.extends ? this.config.extends[filetype] : null
    exists.add(filetype)
    if (!extend || extend.length == 0) return []
    return extend.reduce((arr, curr) => {
      return arr.concat([curr], this.getExtendsFiletypes(curr, exists))
    }, [] as string[])
  }

  public getFiletypes(filetype: string): string[] {
    let filetypes = [filetype]
    if (filetype.indexOf('.') !== -1) {
      filetypes.push(...filetype.split('.'))
    }
    if (filetype == 'latex') filetypes.push('tex')
    if (filetype == 'javascript.jsx') filetypes.push('javascriptreact')
    if (filetype == 'typescript.jsx' || filetype == 'typescript.tsx') filetypes.push('typescriptreact')
    let map = workspace.env.filetypeMap
    if (map && map[filetype]) {
      filetypes.push(map[filetype])
    }
    if (filetype == 'javascriptreact' && !filetypes.includes('javascript')) {
      filetypes.push('javascript')
    }
    if (filetype == 'typescriptreact' && !filetypes.includes('typescript')) {
      filetypes.push('typescript')
    }
    let extendFiletypes = filetypes.reduce((arr, curr) => {
      return arr.concat(this.getExtendsFiletypes(curr))
    }, [] as string[])
    filetypes.push(...extendFiletypes)
    filetypes.reverse()
    return distinct(filetypes)
  }
}
