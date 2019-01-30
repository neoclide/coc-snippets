# coc-snippets

Snippets solution for [coc.nvim](https://github.com/neoclide/coc.nvim)

![2018-12-28 23_38_04](https://user-images.githubusercontent.com/251450/50520168-c2a15c00-0af9-11e9-8842-8205902a324b.gif)

It's capable of:

- Load UltiSnips snippets.
- Load textmate format snippets from coc extensions.
- Provide snippets as completion items.
- Provide trigger key for trigger snippet.
- Provide snippets list for edit snippet.

## Why?

- Use same keys for jump placeholder.
- Nested snippet support.
- Most importantly, it never slows you down.

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

**Note**: you can use same key for both expand snippet and jump forward, jump
forward would always have higher priority.

To open snippet files, use command:

```vim
:CocList snippets
```

## Ultisnips features

Your UltiSnips snippets should work most of time, but sometimes not, check out
feature list below:

- [x] Position check of trigger option, including `b`, `w` and `i`.
- [x] Execute vim, python and shell code in snippet.
- [x] Visual text in placeholder.
- [x] Placeholder transform.
- [ ] Context snippets.
- [ ] Expression snippet (will support).
- [ ] Automatic trigger snippet (will support).
- [ ] Execute shell code with custom shabang (will not support).
- [ ] Reformat snippet after change of placeholder (will not support).
- [ ] Snippet actions (will not support).

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
patterns are not supported, including `(?s)`, `\Z`, `(?(id/name)yes-pattern|no-pattern)`,
`(?x)` and free space syntax of multiple line regular expression.

The failed snippets would not be loaded, you can checkout the errors by open
output channel:

    :CocCommand workspace.showOutput snippets

## F.A.Q

Q: Can i use this without install ultisnips?

A: Yes, this extension could work with or without UltiSnips installed, it works independently,
it doesn't use code or read configuration from UltiSnips.

## License

MIT
