# coc-snippets

Snippets solution for [coc.nvim](https://github.com/neoclide/coc.nvim)

![2019-03-23 00_09_39](https://user-images.githubusercontent.com/251450/54837017-62891300-4d00-11e9-9e53-49742a1a33f2.gif)

_Snippet preview requires [neovim 0.4 or latest vim8](https://github.com/neoclide/coc.nvim/wiki/F.A.Q#how-to-make-preview-window-shown-aside-with-pum)_

It's capable of:

- Load UltiSnips snippets.
- Load snipmate snippets.
- Load VSCode snippets from coc extensions.
- Load VSCode snippets from custom directories.
- Load UltiSnips snippets from configured folder.
- Load massCode snippets from running massCode application.
- Create massCode snippets through the snippets.editSnippets command.
- Provide snippets as completion items.
- Provide expand and expandOrJump keymaps for snippet.
- Provide snippets list for edit snippet.
- Provide `snippets.editSnippets` command for edit user snippets of current filetype.

**Note:** some features of ultisnips and snipmate format snippets not supported,
checkout [Ultisnips features](#ultisnips-features).

## Why?

- Use same keys for jump placeholder.
- Nested snippet support.
- Always async, never slows you down.
- Preview snippet context in float window/popup.
- Improved match for complete items with TextEdit support.
- Edit snippets of current buffer by `:CocList snippets`.

## Python support

Ultisnips provider needs pythonx support on (neo)vim, to check the feature exists,
try:

```vim
:echo has('pythonx')
```

On neovim, run command:

```vim
:checkhealth
```

and make sure you have Python 3 provider for neovim installed.

On vim8, run command:

```vim
:pyx print(1)
```

in your vim, if it throws, it means your vim is not compiled with python support
or the python dynamic lib required by vim is missing(or broken).

**Note:** some python code may require python feature that not supported by the
python interpreter used by vim, error will throw on that case.

Error will be shown when `pythonx` with (neo)vim can't work, fix `pythonx`
support or disable ultisnips support by add `"snippets.ultisnips.enable": false`
in your configuration file.

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

" Use <leader>x for convert visual selected code to snippet
xmap <leader>x  <Plug>(coc-convert-snippet)
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

**Note:** `coc#_select_confirm()` helps select first complete item when there's
no complete item selected, neovim 0.4 or latest vim8 required for this function
work as expected.

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
- [x] Replacement String, (:h UltiSnips-replacement-string), requires latest coc.nvim.
- [x] Update python code block after change of placeholder.
- [ ] Execute shell code with custom shabang (will not support).
- [ ] Option `m`, empty line in snippet not have indentation with coc.nvim.
- [ ] Reformat snippet options, including `t`, `s`.
- [ ] All snippet actions including `pre_expand`, `post_expand` and `jump` (can't support).

**Note**: python regex in snippet are converted to javascript regex, however,
some regex patterns can't be supported by javascript, including
`(?x)` `(?s)` `\Z` `(?(id/name)yes-pattern|no-pattern)`.

## Functions

- `coc#expandable()` return `1` when can do snippet expand.
- `coc#jumpable()` return `1` when snippet activated and can jump to next placeholder.
- `coc#expandableOrJumpable()` return `1` when can do snippet expand or can jump
  to next placeholder.

## Key-mappings

**Note** you can't use `noremap` with `<Plug>` key-mappings.

- `<Plug>(coc-convert-snippet)` Create new snippet with current selected text,
  visual mode only.
- `<Plug>(coc-snippets-expand)` Expand snippet with current inserted text,
  insert mode only.
- `<Plug>(coc-snippets-expand-jump)` Expand snippet or jump to next placeholder
  of current snippet when possible, insert mode only.
- `<Plug>(coc-snippets-select)` Remove selected text and save to
  `g:coc_selected_text` which will replace `$VISUAL` on next snippet expand.

## Commands

- Use `:CocList snippets` to open snippets list used by current buffer.
- Use `:CocCommand snippets.openSnippetFiles` to choose and open a snippet file
  that used by current document.
- Use `:CocCommand snippets.editSnippets` to edit user's ultisnips snippets of
  current document filetype.
- Use `:CocCommand snippets.openOutput` to open output channel of snippets.


## Options

- `snippets.priority`: priority of snippets source, default `90`.
- `snippets.editSnippetsCommand`: Open command used for snippets.editSnippets command, use coc.preferences.jumpCommand by default.
- `snippets.trace`: Trace level of snippets channel.
- `snippets.excludePatterns`: List of filepath patterns to exclude, `$HOME` and other environment variables are expanded.
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
- `snippets.loadVSCodeProjectSnippets`: Load code snippets in folder ${workspaceFolder}/.vscode, default: `true`.
- `snippets.textmateSnippetsRoots`: absolute directories that contains textmate/VSCode snippets to load.
- `snippets.ultisnips.enable`: enable load UltiSnips snippets, default `true`.
- `snippets.ultisnips.trace`: Trace verbose snippet information, default `false`.
- `snippets.ultisnips.directories`: directories that searched for snippet files,
  could be subfolder in every \$runtimepath or absolute paths, default: `["UltiSnips"]`
- `snippets.snipmate.enable`: enable load snipmate snippets, default `true`.
- `snippets.snipmate.author`: author name used for `g:snips_author`
- `snippets.snipmate.trace`: Trace verbose snippet information, default `false`.

## F.A.Q

**Q:** How to check if a snippet successfully loaded?

**A:** Use command `:CocCommand workspace.showOutput snippets`

**Q:** Some ultisnips snippet not works as expected.

**A:** Reformat after change of placeholder feature can't be supported for now,
and some regex pattern can't be converted to javascript regex pattern, so the
snippet can be failed to load.

**Q:** Where to get snippets?

**A:** One solution is install [honza/vim-snippets](https://github.com/honza/vim-snippets) which is widely used.
To create snippets yourself:

- For Ultisnips, create `${filetype}.snippets` in `"snippets.ultisnips.directories"`
- For snipmate snippets, create `${filetype}.snippets` in `snippets` folder
  under your vim's `runtimepath`.
- For VSCode snippets, create `${filetype}.json` in your `"snippets.textmateSnippetsRoots"`.

**Q:** Get error message `ModuleNotFoundError: No module named 'vimsnippets'`

**A:** Make sure [honza/vim-snippets](https://github.com/honza/vim-snippets) in
your vim's `&runtimepath`.

**Q:** Do I need to install [Ultisnips](https://github.com/SirVer/ultisnips).

**A:** No! This extension is designed to work with or without Ultisnips, you can
still install Ultisnips, but this extension would not run any code or read
configuration from it.

**Q:** How to check jumpable or expandable at current position.

**A:** Use functions provided by coc.nvim: `coc#expandable()` `coc#jumpable()` and `coc#expandableOrJumpable()`.

**Q:** It doesn't load snippets from [vim-go](https://github.com/fatih/vim-go).

**A:** It uses `g:UltiSnipsSnippetDirectories` which is not supported, you can
add settings:

```
snippets.ultisnips.directories: [
  "UltiSnips",
  "gosnippets/UltiSnips"
],
```

to load it.

**Q:** How could I add custom UltiSnips snippets.

**A:** You can create snippet files in folder: `$VIMCONFIG/coc/ultisnips`, use
command `:CocCommand snippets.editSnippets` to open user snippet of current
filetype.

## Supporting

If you like this extension, consider supporting me on Patreon or PayPal:

<a href="https://www.patreon.com/chemzqm"><img src="https://c5.patreon.com/external/logo/become_a_patron_button.png" alt="Patreon donate button" /> </a>
<a href="https://www.paypal.com/paypalme/chezqm"><img src="https://werwolv.net/assets/paypal_banner.png" alt="PayPal donate button" /> </a>

## License

MIT
