# coc-snippets

Snippets solution for [coc.nvim](https://github.com/neoclide/coc.nvim)

![2018-12-28 23_38_04](https://user-images.githubusercontent.com/251450/50520168-c2a15c00-0af9-11e9-8842-8205902a324b.gif)

It's capable of:

- Load UltiSnips snippets.
- Load textmate format snippets from coc extensions.
- Provide snippets as completion items.
- Provide trigger key for trigger snippet.
- Provide command to edit snippet files.

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

Remap key to trigger snippet expand:

```vim
imap <C-l> <Plug>(coc-snippets-expand)
```

To open snippet files, use command:

```vim
:CocCommand snippets.editSnippets
```

## About ultisnips features

Your UltiSnips snippets should work most of time, but sometimes not, check out
feature list below:

- [x] Position check of trigger option, including `b`, `w` and `i`.
- [x] Execute vim, python and shell code in snippet.
- [ ] Placeholder transform (will support).
- [ ] Visual text in placeholder (will support).
- [ ] Expression snippet (will support).
- [ ] Automatic trigger snippet (will support).
- [ ] Execute shell code with custom shabang (will not support).
- [ ] Reformat snippet after change of placeholder (will not support).
- [ ] Event hooks for snippet life cycle (will not support).

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

## F.A.Q

Q: Can i use this without install ultisnips?

A: Yes, this extension could work with or without UltiSnips installed, it works independently,
it doesn't use code or read configuration from UltiSnips.

## License

MIT
