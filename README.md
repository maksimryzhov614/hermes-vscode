# Hermes Agent — VS Code Extension

[![Release](https://img.shields.io/github/v/release/maksimryzhov614/hermes-vscode?style=flat-square)](https://github.com/maksimryzhov614/hermes-vscode/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![VS Code ≥1.85](https://img.shields.io/badge/VS%20Code-%E2%89%A51.85-007ACC?style=flat-square&logo=visualstudiocode)](https://code.visualstudio.com)

A VS Code chat panel for a self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent) running on a remote machine — talk to your own LLM the way you talk to Cursor or Copilot, but on your own infrastructure.

```
                ┌─────────────────────────┐
                │   VS Code (any device)  │
                │                         │
                │  ⌘  Hermes chat panel   │
                └────────────┬────────────┘
                             │  HTTPS + Bearer
                             ▼
                ┌─────────────────────────┐
                │     hermes-bridge       │
                │  pairing · auth · proxy │
                └────────────┬────────────┘
                             │
                ┌────────────┴────────────┐
                │   Hermes api_server     │
                │     LLM agent loop      │
                └─────────────────────────┘
```

## Features

- 🔐 **Telegram pairing** — agent's bot sends a one-tap Approve link, no token copy-paste
- 📎 **Attach files & selections** from the editor; **paste screenshots** straight into chat (vision)
- ✏️ **Diff-apply edits** — model emits structured edit blocks, you review/apply with VS Code's native diff
- 🛡 **Three modes** — *Default* (review each), ⚡ *Auto-edit* (Cursor-style), 📋 *Plan* (think first, then execute)
- 💾 **Conversation persists** per workspace — survives reload
- 📊 **Token usage** shown after every reply
- 🪶 **Lightweight** — single ~30 KB `.vsix`, zero runtime dependencies

## Install

Grab the latest `.vsix` from [Releases](https://github.com/maksimryzhov614/hermes-vscode/releases/latest), then:

```bash
code --install-extension hermes-vscode-<version>.vsix --force
```

Or from the GUI: **Extensions → … menu → Install from VSIX…**

## Quick start

1. Open the **Hermes** view (shield icon in the activity bar) — or `Ctrl+Alt+L` / `Cmd+Alt+L`
2. Click **Start pairing** — a one-time code appears
3. Open Telegram → tap **✅ Approve** on the message that arrives from your Hermes bot
4. The panel switches to chat mode — you're done

## Settings

| Key | Default | Purpose |
|---|---|---|
| `hermes.bridgeUrl` | (preset) | URL of the hermes-bridge instance |
| `hermes.autoApply` | `false` | Apply edits without confirmation (legacy; use the Mode picker in the panel) |

## Commands & keybindings

| Command | Default |
|---|---|
| **Hermes: Open Chat** | `Ctrl+Alt+L` / `Cmd+Alt+L` |
| **Hermes: Ask about this** (in editor) | `Ctrl+Alt+H` / `Cmd+Alt+H` |
| **Hermes: Pair this device** | — |
| **Hermes: Sign out** | — |
| **Hermes: Re-discover bridge** | — |
| **Hermes: Attach active file** | — |
| **Hermes: Attach selection** | — |
| **Hermes: Clear conversation history** | — |

Right-click in the editor → **Hermes: Ask about this**. Right-click on a file tab → **Hermes: Attach active file**.

## How edits work

When you ask the agent to change files, it responds with structured blocks:

````
~~~hermes-edit path=src/foo.ts mode=replace
<full new file contents>
~~~
````

Modes: `replace` · `create` · `delete`. Paths resolve relative to the first workspace folder.

The extension parses each block and shows it as a **Review card** in chat. Click *Review* → side-by-side diff → modal Apply/Reject. In **Auto-edit** mode the cards apply themselves immediately. In **Plan** mode the agent must first present a numbered plan and wait for you to reply *go* / *yes* / *proceed* before edit blocks are honoured.

## Self-host the bridge

You need three pieces running on your server:

1. **Hermes Agent** — [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) with `API_SERVER_ENABLED=1` in `~/.hermes/.env`
2. **hermes-bridge** — small aiohttp service that adds Telegram pairing in front of api_server (separate sibling project, see CLAUDE.md for layout reference)
3. A way to expose `bridge:8643` over HTTPS — Cloudflare Tunnel, Tailscale + reverse-proxy, Caddy + your domain, etc.

Then point `hermes.bridgeUrl` at that URL.

## Build from source

```bash
git clone https://github.com/maksimryzhov614/hermes-vscode.git
cd hermes-vscode
npm install
npm run build               # esbuild → out/extension.js
npx vsce package            # → hermes-vscode-<version>.vsix
code --install-extension hermes-vscode-<version>.vsix --force
```

## Releasing

The `release.yml` workflow builds and publishes a Release whenever a `v*.*.*` tag is pushed:

```bash
# bump version in package.json, then:
git tag v0.9.4
git push origin main --tags
```

GitHub Actions builds the `.vsix` and attaches it to a fresh Release with auto-generated notes.

## License

[MIT](./LICENSE) — © 2026 lildebil
