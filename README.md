# GitHub Issue Finder

A small VS Code/Antigravity extension for searching Issues in the active GitHub repository.

## Features

- Search by Issue number: `#123` or `123`
- Search title and body text with GitHub's Issue search API
- Excludes pull requests from keyword results
- Detects the active repository from its `origin` remote
- Renders the selected Issue, Markdown body, and comments in an IDE panel
- Opens `#123` references in another IDE Issue panel
- Opens `source: `path` 3-3, 3-7` references at matching Markdown headings
- Shows the current repository's Issues in a tree view
- Filters by state, author, and label from the view header or Issue metadata
- Groups Issues using `Parent: #123` and GitHub sub-issue relationships
- Adds comments from the IDE panel
- Edits Issue title and Markdown body from the IDE panel
- Caches Issue-related responses in extension storage and revalidates them with GitHub ETags

## Run locally

```powershell
npm install
npm run compile
```

Open this folder in Antigravity/VS Code and press `F5`. In the Extension Development Host, run:

```text
GitHub Issues: Search Current Repository
```

The extension uses the same built-in GitHub authentication session as GitHub Pull Requests. The signed-in account needs access to private repositories being searched.

## Install locally

Compile the extension, then use `Extensions: Install from VSIX...` after packaging it with `vsce`, or run it through the Extension Development Host with `F5`.
