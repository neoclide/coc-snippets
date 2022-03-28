/******************************************************************
MIT License http://www.opensource.org/licenses/mit-license.php
Author Qiming Zhao <chemzqm@gmail> (https://github.com/chemzqm)
*******************************************************************/
import { BasicList, ListContext, ListItem, Location, Mru, Position, Range, Uri, workspace } from 'coc.nvim'
import os from 'os'
import { ProviderManager } from '../provider'

export default class SnippetsList extends BasicList {
  public readonly name = 'snippets'
  public readonly description = 'snippets list'
  constructor(nvim: any, private manager: ProviderManager) {
    super(nvim)
    this.addLocationActions()
  }

  public async loadItems(context: ListContext): Promise<ListItem[]> {
    let { window } = context
    let valid = await window.valid
    if (!valid) return
    let buf = await window.buffer
    let doc = workspace.getDocument(buf.id)
    if (!doc) return []
    let snippets = this.manager.getSnippets(doc.filetype)
    let res: ListItem[] = []
    for (let snip of snippets) {
      let pos: Position = Position.create(snip.lnum, 0)
      let location: Location = Location.create(Uri.file(snip.filepath).toString(), Range.create(pos, Position.create(snip.lnum, 1)))
      let prefix = snip.prefix
      if (prefix.length < 20) {
        prefix = `${prefix}${' '.repeat(20 - prefix.length)}`
      }
      res.push({
        label: `${prefix}\t${snip.description}\t${snip.filepath.replace(os.homedir(), '~')}`,
        filterText: `${snip.prefix} ${snip.description}`,
        location,
        data: { prefix: snip.prefix }
      })
    }
    return res
  }

  public async doHighlight(): Promise<void> {
    let { nvim } = workspace
    nvim.pauseNotification()
    nvim.command('syntax match CocSnippetsPrefix /\\v^[^\\t]+/ contained containedin=CocSnippetsLine', true)
    nvim.command('syntax match CocSnippetsFile /\\v\\t\\S+$/ contained containedin=CocSnippetsLine', true)
    nvim.command('highlight default link CocSnippetsPrefix Identifier', true)
    nvim.command('highlight default link CocSnippetsFile Comment', true)
    void nvim.resumeNotification(false, true)
  }
}
