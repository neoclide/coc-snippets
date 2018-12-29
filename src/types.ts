/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { CompletionItem, TextEdit, Position, Range } from 'vscode-languageserver-types'
import { Document } from 'coc.nvim'

export enum TriggerKind {
  LineBegin,
  WordBoundary,
  InWord,
  Auto
}

export interface UltiSnipsConfig {
  enable: boolean
  pythonVersion: number
  directories: string[]
  extends: { [key: string]: string[] }
}

export interface UltiSnipsFile {
  directory: string
  filetype: string
  filepath: string
  snippets: Snippet[]
  pythonCode?: string
}

export interface SnippetsConfig {
  extends: { [key: string]: string[] }
}

export interface Snippet {
  readonly filepath: string
  readonly lnum: number
  readonly body: string
  readonly prefix: string
  readonly description: string
  readonly triggerKind: TriggerKind
  readonly priority?: number
  // prefix is expression
  readonly expression?: boolean
  provider?: string
}

export interface GlobalContext {
  filepath: string
  visualText?: string
}

export interface SnippetEdit {
  range: Range
  prefix: string
  newText: string
  location: string
  description: string
}

export interface FileItem {
  directory: string
  filetype: string
  filepath: string
}

export abstract class Provider {
  abstract getSnippets(filetype: string): Snippet[]
  abstract getSnippetFiles(filetype: string): string[]
  abstract getTriggerSnippets(document: Document, position: Position): Promise<SnippetEdit[]>
  abstract resolveSnippetBody(item: CompletionItem, context: GlobalContext): Promise<string>
}
