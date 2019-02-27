# coc-snippets

Snippets solution for [coc.nvim](https://github.com/neoclide/coc.nvim)

![2019-02-24 12_04_54](https://user-images.githubusercontent.com/251450/53295003-8570f600-382c-11e9-9e3b-5d4ce2689661.gif)

It's capable of:

- Load UltiSnips snippets.
- Load textmate format snippets from coc extensions.
- Provide snippets as completion items.
- Provide trigger key for trigger snippet.
- Provide snippets list for edit snippet.

## Why?

- Use same keys for jump placeholder.
- Nested snippet support.
- Always async, never slows you down.
- Improved match for complete items with TextEdit support.
- Edit snippet by `:CocList snippets`, sorted by mru.

## Install

In your vim/neovim, run command:

```
:CocInstall coc-snippets
```

## Usage

```vim
" Use <C-l> to trigger snippet expand.
imap <C-l> <Plug>(coc-snippets-expand)
" Use <C-j> to select text for visual text of snippet.
vmap <C-j> <Plug>(coc-snippets-select)
" Use <C-j> to jump to forward placeholder, which is default
let g:coc_snippet_next = '<c-j>'
" Use <C-k> to jump to backward placeholder, which is default
let g:coc_snippet_prev = '<c-k>'
```

**Note**: when using same key for expand snippet and jump forward, jump
forward would have higher priority, to make expand have higher priority, you
should use:

```vim
imap <C-j> <Plug>(coc-snippets-expand-jump)
```

To open snippet files, use command:

```vim
:CocList snippets
```

## Ultisnips features

Some ultisnips features are **not** supported:

- [x] Position check of trigger option, including `b`, `w` and `i`.
- [x] Execute vim, python and shell code in snippet.
- [x] Extends & priority command in snippet file.
- [x] Visual text in placeholder.
- [x] Placeholder and variable transform.
- [x] Expression snippet.
- [x] Automatic trigger snippet.
- [ ] Context snippets.
- [ ] Support loading snipmate snippets.
- [ ] Execute shell code with custom shabang (will not support because it's
      dangerous).
- [ ] Automatic reformat snippet after change of placeholder.
- [ ] Format related snippet options, including `t`, `s` and `m`.
- [ ] Snippet actions.

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

- `snippets.shortcut`, shortcut in completion menu, default `S`.
- `snippets.ultisnips.enable`: enable load UltiSnips snippets, default `true`.
- `snippets.ultisnips.pythonVersion`: python version to use for run python code,
  default to `3`, will always use `pyx` commands on vim.
- `snippets.ultisnips.directories`: directories that searched for snippet files,
  could be subfolder in every \$runtimepath or absolute paths, default:
  `["UltiSnips"]`
- `snippets.loadFromExtensions`: specify whether to load snippets from
  extensions, default: `true`

## Regular expression convert

Python regular expression of UltiSnips would be converted to javascript regex, however some
patterns are not supported, including `(?s)`, `\Z`, `(?(id/name)yes-pattern|no-pattern)`.

The failed snippets would not be loaded, you can checkout the errors by open
output channel:

    :CocCommand workspace.showOutput snippets

## F.A.Q

Q: Can i use this without install ultisnips?

A: Yes, this extension could work with or without UltiSnips installed, it works independently,
it doesn't use code or read configuration from UltiSnips.

Q: How to use same key for select next completion item and expand snippet?

A: Use condition keymap like:

```vim
inoremap <silent><expr> <TAB>
      \ pumvisible() ? "\<C-n>" :
      \ <SID>check_back_space() ? "\<TAB>" :
      \ coc#rpc#request('doKeymap', ['snippets-expand', "\<TAB>"])

function! s:check_back_space() abort
  let col = col('.') - 1
  return !col || getline('.')[col - 1]  =~# '\s'
endfunction
```

## License

MIT
