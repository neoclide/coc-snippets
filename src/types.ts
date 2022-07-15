/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { Range, CompletionItem, TextEdit, CompletionContext, CompleteOption } from 'coc.nvim'

export enum TriggerKind {
  SpaceBefore,
  LineBegin,
  WordBoundary,
  InWord,
}

export interface UltiSnippetOption {
  regex?: string
  context?: string
}

export interface VimCompletionContext extends CompletionContext {
  option: CompleteOption
}

export interface Config {
  extends: { [index: string]: string[] }
  excludes: string[]
  trace: boolean
}

export interface UltiSnipsConfig extends Config {
  enable: boolean
  usePythonx: boolean
  pythonVersion: number
  directories: string[]
}

export interface SnipmateConfig extends Config {
  author: string
}

export interface TextmateConfig extends Config {
  snippetsRoots: string[]
  loadFromExtensions: boolean
  projectSnippets: boolean
}

export interface MassCodeConfig extends Config {
  port: number
  host: string
}

export interface UltiSnipsFile {
  directory: string
  filetype: string
  filepath: string
  snippets: Snippet[]
  extendFiletypes: string[]
  pythonCode?: string
  clearsnippets?: number
}

export interface SnipmateFile {
  filepath: string
  filetype: string
  snippets: Snippet[]
}

export interface Snippet {
  // prefix + no regex + no context + same triggerKind
  readonly filepath: string
  readonly lnum: number
  readonly body: string
  readonly prefix: string
  readonly description: string
  readonly triggerKind: TriggerKind
  readonly filetype: string
  readonly priority?: number
  // prefix is expression
  readonly regex?: RegExp
  // check expand by eval expression
  readonly context?: string
  readonly autoTrigger?: boolean
  readonly originRegex?: string
  preExpand?: string
  postExpand?: string
  postJump?: string
  extensionId?: string
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
  priority: number
  regex?: string
  context?: string
}

export interface SnippetEditWithSource extends SnippetEdit {
  source: string
}

export interface FileItem {
  directory: string
  filetype: string
  filepath: string
}

export interface ReplaceItem {
  index: number
  length: number
  newText: string
}
