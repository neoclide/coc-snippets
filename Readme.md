# coc-snippets

Snippets solution for [coc.nvim](https://github.com/neoclide/coc.nvim)

![2019-03-23 00_09_39](https://user-images.githubusercontent.com/251450/54837017-62891300-4d00-11e9-9e53-49742a1a33f2.gif)

It's capable of:

- Load UltiSnips snippets.
- Load snipmate snippets.
- Load VSCode snippets from coc extensions.
- Load VSCode snippets from custom directories.
- Load UltiSnips snippets from configuration folder.
- Provide snippets as completion items.
- Provide expand and expandOrJump keymaps for snippet.
- Provide snippets list for edit snippet.
- Provide `snippets.editSnippets` command for edit user snippets of current filetype.

## Why?

- Use same keys for jump placeholder.
- Nested snippet support.
- Always async, never slows you down.
- Improved match for complete items with TextEdit support.
- Edit snippets of current buffer by `:CocList snippets`, sorted by mru.

## Install

In your vim/neovim, run command:

```
:CocInstall coc-snippets
```

## Examples

```vim
" Use <C-l> for trigger snippet expand.
imap <C-l> <Plug>(coc-snippets-expand)

" Use <C-j> for select text for visual placeholder of snippet.
vmap <C-j> <Plug>(coc-snippets-select)

" Use <C-j> for jump to next placeholder, it's default of coc.nvim
let g:coc_snippet_next = '<c-j>'

" Use <C-k> for jump to previous placeholder, it's default of coc.nvim
let g:coc_snippet_prev = '<c-k>'

" Use <C-j> for both expand and jump (make expand higher priority.)
imap <C-j> <Plug>(coc-snippets-expand-jump)
```

Make `<tab>` used for trigger completion, completion confirm, snippet expand and jump like VSCode.

```vim
inoremap <silent><expr> <TAB>
      \ pumvisible() ? coc#_select_confirm() :
      \ coc#expandableOrJumpable() ? "\<C-r>=coc#rpc#request('doKeymap', ['snippets-expand-jump',''])\<CR>" :
      \ <SID>check_back_space() ? "\<TAB>" :
      \ coc#refresh()

function! s:check_back_space() abort
  let col = col('.') - 1
  return !col || getline('.')[col - 1]  =~# '\s'
endfunction

let g:coc_snippet_next = '<tab>'
```

**Note:** `coc#_select_confirm()` helps select complete item (when `"suggest.noselect"` is true)

## Ultisnips features

Some ultisnips features are **not** supported:

- [x] Position check of trigger option, including `b`, `w` and `i`.
- [x] Execute vim, python and shell code in snippet.
- [x] `extends`, `priority` and `clearsnippets` command in snippet file.
- [x] Visual placeholder.
- [x] Placeholder and variable transform.
- [x] Expression snippet.
- [x] Automatic trigger snippet.
- [x] Context snippets.
- [x] Support loading snipmate snippets.
- [ ] Execute shell code with custom shabang (will not support).
- [ ] Automatic reformat snippet after change of placeholder (can't support).
- [ ] Format related snippet options, including `t`, `s` and `m` (can't support).
- [ ] Snippet actions (can't support).

**Note** coc-snippets convert UltiSnips snippets to textmate snippets and send
it to coc's snippets manager, format snippets after snippet insert will not be
supported except for placeholder transform which also supported by textmate
snippet.

## Options

- `snippets.priority`: priority of snippets source, default `90`.
- `snippets.extends`: extends filetype's snippets with other filetypes, example:

  ```json
  {
    "cpp": ["c"],
    "javascriptreact": ["javascript"],
    "typescript": ["javascript"]
  }
  ```

- `snippets.userSnippetsDirectory`, Directory that contains custom user ultisnips snippets, use ultisnips in extension root by default.
- `snippets.shortcut`, shortcut in completion menu, default `S`.
- `snippets.autoTrigger`: enable auto trigger for auto trigger ultisnips snippets, default `true`.
- `snippets.triggerCharacters`: trigger characters for completion, default `[]`.
- `snippets.loadFromExtensions`: load snippets from coc.nvim extensions, default: `true`.
- `snippets.textmateSnippetsRoots`: absolute directories that contains textmate/VSCode snippets to load.
- `snippets.ultisnips.enable`: enable load UltiSnips snippets, default `true`.
- `snippets.ultisnips.usePythonx`: use `pythonx` for eval python code when possible, default `true`.
- `snippets.ultisnips.pythonVersion`: when `usePythonx` is false, python version to use for
  python code, default to `3`.
- `snippets.ultisnips.directories`: directories that searched for snippet files,
  could be subfolder in every \$runtimepath or absolute paths, default: `["UltiSnips"]`
- `snippets.snipmate.enable`: enable load snipmate snippets, default `true`.
- `snippets.snippets.author`: author name used for `g:snips_author`

## Commands

- Use `:CocList snippets` to open snippets list.
- Use `:CocCommand snippets.editSnippets` to edit user snippet of current filetype.
- Use `:CocCommand snippets.openSnippetFiles` to open snippet files of current filetype.

## Regular expression convert

Python regular expression of UltiSnips would be converted to javascript regex, however some
patterns are not supported, including `\u` `(?s)` `\Z` `(?(id/name)yes-pattern|no-pattern)`.

The failed snippets would not be loaded, you can checkout the errors by check output:

    :CocCommand workspace.showOutput snippets

## F.A.Q

**Q:** Where to get snippets?

**A:** One solution is install [honza/vim-snippets](https://github.com/honza/vim-snippets) which is widely used.

**Q:** Do I need to install [Ultisnips](https://github.com/SirVer/ultisnips).

**A:** No! This extension is designed to work with or without Ultisnips, you can
still install Ultisnips, but this extension would not run any code of read
configuration from it.

**Q:** How to check jumpable or expandable at current position.

**A:** Use functions: `coc#expandable()` `coc#jumpable()` and `coc#expandableOrJumpable()`.

**Q:** It doesn't load snippets from [vim-go](https://github.com/fatih/vim-go).

**A:** It use `g:UltiSnipsSnippetDirectories` which is not supported, you can
add settings:

```
snippets.ultisnips.directories: [
  "UltiSnips",
  "gosnippets/UltiSnips"
],
```

to load it.

**Q:** Ho could I add custom UltiSnips snippets.

**A:** You can create snippet files in folder: `$VIMCONFG/coc/ultisnips`, use
command `:CocCommand snippets.editSnippets` to open user snippet of current
filetype.

## License

MIT
