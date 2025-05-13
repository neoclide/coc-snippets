/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { BasicList, ListContext, ListItem, Location, Position, Range, Uri, workspace } from 'coc.nvim'
import os from 'os'
import { ProviderManager } from '../provider'
import { getSnippetFiletype } from '../util'

function formatPrefix(prefix: string): string {
  if (prefix.length >= 20) return prefix.slice(0, 17) + '...'
  return prefix + ' '.repeat(20 - prefix.length)
}

export default class SnippetsList extends BasicList {
  public readonly name = 'snippets'
  public readonly description = 'snippets list'
  constructor(_nvim, private manager: ProviderManager) {
    super()
    this.addLocationActions()
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let { window } = context
    let valid = await window.valid
    if (!valid) return
    let buf = await window.buffer
    let doc = workspace.getDocument(buf.id)
    if (!doc) return []
    let filetype = getSnippetFiletype(doc)
    let snippets = this.manager.getSnippets(filetype)
    let res: ListItem[] = []
    for (let snip of snippets) {
      let pos: Position = Position.create(snip.lnum, 0)
      let location: Location = Location.create(Uri.file(snip.filepath).toString(), Range.create(pos, Position.create(snip.lnum, 1)))
      let prefix = snip.prefix.length ? snip.prefix : snip.originRegex ?? ''
      res.push({
        label: `${formatPrefix(prefix)}\t${snip.description}\t${snip.filepath.replace(os.homedir(), '~')}`,
        filterText: `${snip.prefix} ${snip.description}`,
        location,
        data: { prefix }
      })
    }
    res.sort((a, b) => a.data.prefix.localeCompare(b.data.prefix))
    return res
  }

  public async doHighlight(): Promise<void> {
    let { nvim } = workspace
    nvim.pauseNotification()
    nvim.command('syntax match CocSnippetsPrefix /\\v^.{1,20}/ contained containedin=CocSnippetsLine', true)
    nvim.command('syntax match CocSnippetsFile /\\v\\t\\S+$/ contained containedin=CocSnippetsLine', true)
    nvim.command('highlight default link CocSnippetsPrefix Identifier', true)
    nvim.command('highlight default link CocSnippetsFile Comment', true)
    void nvim.resumeNotification(false, true)
  }
}
