# Hermes Agent — VS Code Extension

**English** · [Русский](./README.md)

[![Release](https://img.shields.io/github/v/release/maksimryzhov614/hermes-vscode?style=flat-square&cacheSeconds=60)](https://github.com/maksimryzhov614/hermes-vscode/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![VS Code ≥1.85](https://img.shields.io/badge/VS%20Code-%E2%89%A51.85-007ACC?style=flat-square&logo=visualstudiocode)](https://code.visualstudio.com)

A VS Code chat panel for a self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent). In spirit — like Cursor or Copilot, but with a fully self-hosted backend.

```
                ┌─────────────────────────┐
                │   VS Code (any device)  │
                │                         │
                │  ⌘  Hermes chat panel   │
                └────────────┬────────────┘
                             │  HTTPS + Bearer token
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

- 🔐 **Telegram pairing** — bot sends a one-tap Approve link, no token copy-paste
- 📎 **Attach files & selections** from the editor; **paste screenshots** straight into chat (vision)
- ✏️ **Diff-apply edits** — model emits structured edit blocks, you review/apply with VS Code's native diff
- 🛡 **Three modes** — *Default* (review each), ⚡ *Auto-edit* (Cursor-style), 📋 *Plan* (think first, then execute)
- 💾 **Conversation persists** per workspace — survives reload
- 📊 **Token usage** shown after every reply
- 🪶 **Lightweight** — single ~30 KB `.vsix`, zero runtime dependencies

## ⚠️ You need a self-hosted bridge

This is **only the client**. The server side (Hermes Agent + hermes-bridge) must run somewhere you control — VPS, home server, cloud. Without a bridge URL, the extension does nothing.

**Server setup guide** — see [`bridge/README.md`](./bridge/README.md). Full walkthrough: prerequisites, configuration, exposing it via Cloudflare Tunnel or Tailscale.

In short:
1. Install **Hermes Agent** ([github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)) and enable `api_server`
2. Run **hermes-bridge** (source in this repo's `bridge/` folder)
3. Expose it over HTTPS
4. You'll get a URL like `https://hermes.example.com` — needed on first launch

## Install — Linux

Download the latest `.vsix` from [Releases](https://github.com/maksimryzhov614/hermes-vscode/releases/latest), then:

```bash
cd ~/Downloads
code --install-extension hermes-vscode-<version>.vsix --force
```

## Install — Windows

In **PowerShell**:

```powershell
cd $HOME\Downloads
```
```powershell
code --install-extension .\hermes-vscode-<version>.vsix --force
```

If the `code` command is not on PATH: open VS Code → `Ctrl+Shift+P` → **Shell Command: Install 'code' command in PATH**, then restart PowerShell.

## Install — macOS

If you don't have VS Code yet:
```bash
brew install --cask visual-studio-code
```

Make sure the `code` CLI is on your PATH: open VS Code → `Cmd+Shift+P` → **Shell Command: Install 'code' command in PATH**, then restart Terminal.

```bash
cd ~/Downloads
code --install-extension hermes-vscode-<version>.vsix --force
```

Reload the window: `Cmd+Shift+P` → **Developer: Reload Window**.

## First launch

1. Open settings (`Ctrl+,` / `Cmd+,`) → find `hermes.bridgeUrl` → enter your bridge URL (`https://hermes.example.com`)
2. Click the **shield** icon in the activity bar (or `Ctrl+Alt+L` / `Cmd+Alt+L`)
3. Click **Start pairing** — a one-time code appears
4. Open Telegram → your bot will send a message with the code and an **✅ Approve** button — tap it
5. The panel switches to chat mode in a second — done

## Settings

| Key | Default | Purpose |
|---|---|---|
| `hermes.bridgeUrl` | (empty) | URL of your bridge — required |
| `hermes.autoApply` | `false` | Apply edits without confirmation (legacy; use the Mode pill in the panel instead) |

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

## How file edits work

When you ask the agent to change files, it responds with structured blocks:

````
~~~hermes-edit path=src/foo.ts mode=replace
<full new file contents>
~~~
````

Modes: `replace` · `create` · `delete`. Paths resolve relative to the first workspace folder.

The extension parses each block and shows it as a **Review card** in chat. Click *Review* → side-by-side diff → modal Apply/Reject.

In **Auto-edit** mode the cards apply themselves immediately. In **Plan** mode the agent must first present a numbered plan and wait for you to reply *go* / *yes* / *proceed* before edit blocks are honoured.

## Build from source

```bash
git clone https://github.com/maksimryzhov614/hermes-vscode.git
cd hermes-vscode
npm install
npm run build               # esbuild → out/extension.js
npx vsce package            # → hermes-vscode-<version>.vsix
code --install-extension hermes-vscode-<version>.vsix --force
```

## Releases

The `release.yml` workflow builds and publishes a Release whenever a `v*.*.*` tag is pushed:

```bash
# bump version in package.json, then:
git tag v0.9.5
git push origin main --tags
```

GitHub Actions builds the `.vsix` and attaches it to a fresh Release with auto-generated notes.

## Repo layout

```
hermes-vscode/
├── src/                      VS Code extension (TypeScript)
├── bridge/                   server side (see bridge/README.md)
│   ├── bridge.py             aiohttp service
│   ├── .env.example          configuration
│   └── hermes-bridge.service systemd unit
├── .github/workflows/
│   └── release.yml           CI: tag → build → Release with .vsix
├── media/icon.svg
├── package.json
├── README.md                 Russian (default)
└── README.en.md              English (this file)
```

## License

[MIT](./LICENSE) — © 2026 lildebil
