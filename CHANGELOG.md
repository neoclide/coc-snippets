# 3.0.6

- Avoid check and show context snippets in pum.

# 3.0.5

- Fix `snippets.editSnippets` not contains global snippet files.
- Fix snipmate viml interpolation not work.

# 3.0.4

- Register snippets.editSnippets when ultisnips enabled.
- Fix same directory check on case insensive system.

# 3.0.3

- Fix trigger kind for regex snippet.

# 3.0.2

- Add command `snippets.openOutput`.

# 3.0.1

- Fix languageIds of textmate snippets.
- Fix bad params for resolveSnippet.

# 3.0.0

- Not parse ultisnip snippets.

# 2.5.2

- Fix escape for `$` in ultisnip body.

# 2.5.1

- Respect languageIds in `scope` for VSCode snippets.
- Respect languageId in comment for VSCode snippets.
- Load global scoped VSCode snippets for all filetypes.
- Support workspace snippets in `.vscode` folder.

# 2.5.0

- Load snippets when necessary.
- Not show progress status item on loading.
- Load `all.snippets`of ultisnip when filetype is empty.
- Support extends for snipmate snippets.
- Support configuration `snippets.excludePatterns`.
