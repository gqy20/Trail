# Trail

Capture a Chrome tab group as a research trail.

## MVP scope

- Detect the current Chrome Tab Group from the active tab.
- Start and stop semi-automatic recording for that group.
- Fall back to the current window when the active tab is not grouped.
- Save completed sessions in `chrome.storage.local`.
- Generate a mock Research Markdown document without AI.
- Copy or download the generated Markdown.

## Development

```bash
npm install
npm run build
```

Load the generated `dist/` directory as an unpacked extension in Chrome.

## Commit style

Use conventional commits:

```text
feat(scope): message
fix(scope): message
chore(scope): message
```
