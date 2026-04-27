# hermes-vscode

VS Code extension. Thin remote client for the user's self-hosted Hermes Agent. Pairs once via Telegram, then chats / attaches files / pastes screenshots / applies code edits with diff preview.

## Stack

- TypeScript, esbuild bundle, packaged as `.vsix` via `@vscode/vsce`
- No runtime deps (uses `node:http`, `node:https`, `vscode` API only)
- Targets VS Code ≥ 1.85

## Layout

```
src/
├── extension.ts        ← entry; commands, state, sendPrompt, diff handling
├── bridgeClient.ts     ← HTTP client for the bridge (NDJSON not used; SSE for chat stream)
├── chatPanel.ts        ← webview UI; paste-image handler; renders Edit cards
├── codeContext.ts      ← attach active file/selection, resolve @filename mentions
├── diffApply.ts        ← parse ~~~hermes-edit~~~ blocks, vscode.diff preview, apply/reject
└── discovery.ts        ← localhost + Tailscale peer scan to auto-find bridge URL
media/icon.svg
package.json            ← contributes commands, view, settings (default bridgeUrl baked in)
esbuild.config.mjs
```

## Build & deploy

```bash
npx tsc --noEmit
npm run build                              # esbuild → out/extension.js
npx vsce package --allow-missing-repository  # → hermes-vscode-<v>.vsix

# Push to user's Windows machine via Tailscale (no SSH needed):
tailscale file cp hermes-vscode-<v>.vsix desktop-6v88lc6:
# On Windows:
#   cd $HOME\Downloads
#   tailscale file get .
#   code --install-extension .\hermes-vscode-<v>.vsix --force
```

If `tailscale file cp` errors with "file access denied" → `sudo tailscale set --operator=dev` once.

## Talks to

- **`hermes-bridge`** (sister project at `../hermes-bridge`) over `https://hermes.lildebil0.ru` (default baked into `package.json` settings).
- That bridge proxies to **hermes' built-in api_server** on `:8642` and authenticates client requests with per-token bearer tokens.

If you change the bridge's URL, **also bump** the `hermes.bridgeUrl` default in `package.json` and rebuild the `.vsix`.

## The diff-apply contract

`extension.ts → SYSTEM_PROMPT` steers the model to wrap proposed file changes in:

```
~~~hermes-edit path=relative/path.ext mode=replace|create|delete
<full new file contents>      (empty body for delete)
~~~
```

`diffApply.ts → parseEdits` extracts each block. The webview shows a **Review** card per edit; clicking it opens `vscode.diff` and prompts modal Apply/Reject. Paths resolve relative to the first workspace folder.

If you change either the prompt or the regex, change them together — they have to agree on the syntax exactly.

## Pairing flow

1. Extension reads token from `vscode.SecretStorage`. If absent → shows "Pair this device" button.
2. Click → `POST /pair/init` → bridge sends a Telegram message to the user's home chat with a one-time `https://hermes.lildebil0.ru/pair/approve?...` link.
3. User taps in Telegram → bridge mints token, marks code approved.
4. Extension polls `/pair/poll` every 2 s for up to 5 min, on success stores the token.

## Discovery

If `hermes.bridgeUrl` setting is empty, `discovery.ts` tries:
1. `http://127.0.0.1:8643/health` (bridge on same machine, e.g. WSL)
2. `tailscale status --json` → probe each online peer's `:8643/health`

First match wins, cached in `globalState`. Hardcoded `https://hermes.lildebil0.ru` default in `package.json` makes discovery moot for our standard Windows install — kept as a fallback.

## Conventions to keep

- **Bake the bridge URL into the `.vsix`** — never ask the user to fill in Settings. (Lived feedback: user explicitly demanded zero-config UX.)
- **Token in SecretStorage**, never in workspace settings.
- **Multimodal messages**: when there are images, content is `ContentPart[]`; otherwise plain string. The OpenAI-compat upstream accepts both.
- **Stateless chat**: history is sent in full each request. Server-side session continuity exists (`X-Hermes-Session-Id`) but we don't use it currently — keeps the extension simple.
- **No bundled deps**: keep esbuild output small (~25 KB). Don't add npm runtime libs unless really needed.

## When things break

| Symptom in the panel | Where to look |
|---|---|
| `Invalid URL` on Pair click | `hermes.bridgeUrl` empty/malformed; check Settings |
| `EACCES` / `Could not connect` | Tailscale DNS/route on Windows; or bridge down server-side |
| `HTTP 401` mid-chat | Token revoked / `bridge.db` wiped; user runs **Hermes: Sign out**, re-pairs |
| Edits not parsed | Check that model output really has `~~~hermes-edit~~~` (raw text in panel) — the model may have stripped fences in its formatting |
| Empty assistant message | Hermes-side issue — see `~/.hermes/logs/agent.log`, often quota / `openai-codex` auth |

VS Code logs: **View → Output → "Hermes"**.
Webview-side errors: `Ctrl+Shift+P` → "Developer: Open Webview Developer Tools".

## Versioning

Bump `version` in `package.json` for any user-facing change. Default is to ship via `tailscale file cp` to the user's `desktop-6v88lc6`; they install with `--force` to overwrite.

## See also

- Sister project: `../hermes-bridge/CLAUDE.md` (server side)
- Cross-cutting: `../CLAUDE.md` (very brief project index)
