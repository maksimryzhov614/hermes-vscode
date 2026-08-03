# Contributing

Keep changes focused and open an issue before proposing a large behavior or
protocol change.

## Local verification

Hermes requires Node.js 20 or newer. Install the locked dependencies and run
the same core checks used by CI:

```sh
npm ci
npm test
npx tsc --noEmit
npm run build
npx vsce package --no-dependencies --out /tmp/hermes-vscode.vsix
```

Add a failing test before changing edit parsing, workspace-path handling, or a
workflow contract. Never commit pairing codes, bridge URLs, logs containing
authorization headers, or real workspace paths.
