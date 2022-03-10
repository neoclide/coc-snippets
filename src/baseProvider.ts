import { Document, Position } from 'coc.nvim'
import minimatch from 'minimatch'
import { Config, Snippet, SnippetEdit } from './types'
import { distinct } from './util'

export default abstract class BaseProvider {
  constructor(protected config: Config) {
  }

  public abstract init(): Promise<void>
  public abstract getSnippets(filetype: string): Promise<Snippet[]>
  public abstract getSnippetFiles(filetype: string): Promise<string[]>
  public abstract getTriggerSnippets(document: Document, position: Position, autoTrigger?: boolean): Promise<SnippetEdit[]>
  public resolveSnippetBody?(snippet: string): Promise<string>

  public async checkContext(_context: string): Promise<any> {
    return true
  }

  protected isIgnored(filepath: string): boolean {
    let ignored = false
    let { excludes } = this.config
    for (let p of excludes) {
      if (minimatch(filepath, p, { dot: true })) {
        ignored = true
        break
      }
    }
    return ignored
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
    return distinct(filetypes)
  }
}
