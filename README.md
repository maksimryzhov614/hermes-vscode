# Hermes Agent — VS Code Extension

A VS Code chat panel for a self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent) running on a remote machine.

- 🤖 **Talk to your remote LLM** through a polished chat panel without installing the agent locally
- 🔐 **Pair via Telegram** — the agent's bot sends a one-tap Approve link; no copy-pasting tokens
- 📎 **Attach files & selections** from the editor; **paste screenshots** straight into chat (vision-enabled)
- ✏️ **Diff-apply edits** — the model emits structured edit blocks, you review/apply with VS Code's native diff
- 🛡 **Three modes** — *Default* (review each), ⚡ *Auto-edit* (Cursor-style), 📋 *Plan* (think first, then execute)
- 🪶 **Lightweight** — single ~30 KB `.vsix`, no runtime dependencies

## Installation

Download the latest `.vsix` from [Releases](https://github.com/Maksim Ryzhov/hermes-vscode/releases), then:

```bash
code --install-extension hermes-vscode-<version>.vsix
```

Or install from VSIX in the GUI: `Extensions` → `…` menu → **Install from VSIX…**

## Setup

1. Open the **Hermes** view (shield icon in the activity bar) — or `Ctrl+Alt+L` / `Cmd+Alt+L`
2. By default the extension talks to the author's bridge. To use **your own**, set `hermes.bridgeUrl` in settings (see *Self-host your bridge* below)
3. Click **Start pairing** — a one-time code appears
4. Open Telegram → tap **✅ Approve** on the message that arrives from your Hermes bot
5. The panel switches to chat mode. You're done.

## Self-host your bridge

This extension is a **client**. The server side has two pieces, both expected to run on the same machine:

- **Hermes Agent** — [github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), with `api_server` platform enabled (`API_SERVER_ENABLED=1` in `~/.hermes/.env`)
- **hermes-bridge** — a thin aiohttp service that adds Telegram-driven pairing on top of `api_server`. Source in `bridge/` (sister repo or sibling project)

Once both run on your server, expose the bridge over HTTPS (Cloudflare Tunnel, Tailscale, Caddy, your choice), and point `hermes.bridgeUrl` at it.

## Settings

| Key | Default | Purpose |
|---|---|---|
| `hermes.bridgeUrl` | (author's URL) | URL of the hermes-bridge instance |
| `hermes.autoApply` | `false` | Auto-apply file edits without confirmation (legacy; use the **Mode** picker in the panel instead) |

## Commands

| Command | Default keybinding |
|---|---|
| `Hermes: Open Chat` | `Ctrl+Alt+L` / `Cmd+Alt+L` |
| `Hermes: Ask about this` | `Ctrl+Alt+H` / `Cmd+Alt+H` (in editor) |
| `Hermes: Pair this device` | — |
| `Hermes: Sign out (forget token)` | — |
| `Hermes: Re-discover bridge` | — |
| `Hermes: Attach active file` | — |
| `Hermes: Attach selection` | — |
| `Hermes: Clear conversation history` | — |

## How edits work

When you ask the agent to change files, it responds with one or more structured blocks:

````
~~~hermes-edit path=src/foo.ts mode=replace
<full new file contents>
~~~
````

Modes: `replace` · `create` · `delete`. Paths resolve relative to the first workspace folder.

The extension parses each block and shows it as a **Review card** in the chat. Click *Review* → VS Code opens a side-by-side diff → modal *Apply* or *Reject*.

In **Auto-edit** mode the cards apply themselves immediately. In **Plan** mode the agent must first present a numbered plan and wait for you to reply *go* / *yes* / *proceed* before any edit blocks are honoured.

## Build from source

```bash
git clone https://github.com/Maksim Ryzhov/hermes-vscode.git
cd hermes-vscode
npm install
npm run build               # esbuild → out/extension.js
npx vsce package            # → hermes-vscode-<version>.vsix
code --install-extension hermes-vscode-<version>.vsix --force
```

## Architecture

```
VS Code extension  ──HTTPS+Bearer──►  hermes-bridge  ──HTTP──►  Hermes api_server
   (this repo)                            │                       (the LLM agent)
                                          └─► Telegram Bot API
                                              (Approve link for first-time pairing)
```

- The extension never talks to Hermes directly — only via the bridge
- The bridge mints per-client bearer tokens (`hbk_…`) stored in VS Code's `SecretStorage`
- Tokens are bound to a TTL (90 days by default) and can be revoked from the bridge or via `Hermes: Sign out`

## License

[MIT](./LICENSE) — © 2026 Maksim Ryzhov
