import { Snippet, SnippetEdit, GlobalContext } from './types'
import { CompletionItem, Position } from 'vscode-languageserver-types'
import { Document } from 'coc.nvim'
import { distinct } from './util'

export interface Config {
  extends: { [index: string]: string[] }
  [key: string]: any
}

export default abstract class BaseProvider {
  constructor(protected config: Config) {
  }

  abstract getSnippets(filetype: string): Snippet[]
  abstract getSnippetFiles(filetype: string): string[]
  abstract getTriggerSnippets(document: Document, position: Position): Promise<SnippetEdit[]>
  abstract resolveSnippetBody(item: CompletionItem, context: GlobalContext): Promise<string>

  public getFiletypes(filetype: string): string[] {
    let extend = this.config.extends ? this.config.extends[filetype] : null
    let filetypes = filetype.split('.')
    if (extend && extend.length) {
      filetypes = extend.concat(filetypes)
    }
    filetypes.reverse()
    return distinct(filetypes)
  }
}
