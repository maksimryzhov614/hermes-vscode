# Hermes Agent — расширение для VS Code

[![Release](https://img.shields.io/github/v/release/maksimryzhov614/hermes-vscode?style=flat-square)](https://github.com/maksimryzhov614/hermes-vscode/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](./LICENSE)
[![VS Code ≥1.85](https://img.shields.io/badge/VS%20Code-%E2%89%A51.85-007ACC?style=flat-square&logo=visualstudiocode)](https://code.visualstudio.com)

Чат-панель в VS Code для self-hosted [Hermes Agent](https://github.com/NousResearch/hermes-agent), который крутится на твоём сервере. По духу — как Cursor или Copilot, только бэкенд полностью твой.

```
                ┌─────────────────────────┐
                │   VS Code (любой ПК)    │
                │                         │
                │  ⌘  Hermes chat panel   │
                └────────────┬────────────┘
                             │  HTTPS + Bearer-токен
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

## Возможности

- 🔐 **Pairing через Telegram** — бот шлёт одноразовую ссылку «Approve», ничего вручную копировать не нужно
- 📎 **Прикрепить файл/выделение** из редактора, **вставить скриншот** прямо в чат (vision)
- ✏️ **Diff-apply** правок — модель отдаёт структурированные блоки, ты ревьюишь через нативный VS Code diff
- 🛡 **Три режима** — *Default* (ревью каждой правки), ⚡ *Auto-edit* (Cursor-style), 📋 *Plan* (сначала план, потом исполнение)
- 💾 **История диалога** сохраняется по workspace — переживёт reload
- 📊 **Расход токенов** виден после каждого ответа
- 🪶 **Лёгкое** — один `.vsix` ~30 КБ, никаких runtime-зависимостей

## ⚠️ Важно: нужен self-hosted bridge

Это **только клиент**. Серверная часть (Hermes Agent + hermes-bridge) должна работать у тебя — на VPS, домашнем сервере, в облаке. Без bridge URL расширение работать не будет.

**Как поднять серверную часть** — см. [`bridge/README.md`](./bridge/README.md). Там полный гайд: что нужно поставить, как настроить, как открыть HTTPS-доступ через Cloudflare Tunnel или Tailscale.

Коротко:
1. Поставь **Hermes Agent** ([github.com/NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)) и включи `api_server`
2. Запусти **hermes-bridge** (исходник в `bridge/` этого репо)
3. Открой ему HTTPS-доступ снаружи
4. Получишь URL вида `https://hermes.example.com` — он понадобится при первом запуске расширения

## Установка расширения

Скачай последний `.vsix` из [Releases](https://github.com/maksimryzhov614/hermes-vscode/releases/latest), затем:

```bash
code --install-extension hermes-vscode-<версия>.vsix --force
```

Или через GUI: **Extensions → ⋯ → Install from VSIX…**

## Первый запуск

1. Открой настройки (`Ctrl+,` / `Cmd+,`) → найди `hermes.bridgeUrl` → впиши URL своего bridge (`https://hermes.example.com`)
2. Кликни иконку **щит** на activity bar (или `Ctrl+Alt+L` / `Cmd+Alt+L`)
3. Жми **Start pairing** — появится одноразовый код
4. Открой Telegram → твой бот пришлёт сообщение с кодом и кнопкой **✅ Approve** — тапни
5. Через секунду панель переключится в режим чата — готово

## Настройки

| Ключ | По умолчанию | Назначение |
|---|---|---|
| `hermes.bridgeUrl` | (пусто) | URL твоего bridge — обязательно укажи |
| `hermes.autoApply` | `false` | Применять правки без подтверждения (legacy; используй вместо него Mode-pill в панели) |

## Команды и хоткеи

| Команда | Хоткей |
|---|---|
| **Hermes: Open Chat** | `Ctrl+Alt+L` / `Cmd+Alt+L` |
| **Hermes: Ask about this** (в редакторе) | `Ctrl+Alt+H` / `Cmd+Alt+H` |
| **Hermes: Pair this device** | — |
| **Hermes: Sign out** | — |
| **Hermes: Re-discover bridge** | — |
| **Hermes: Attach active file** | — |
| **Hermes: Attach selection** | — |
| **Hermes: Clear conversation history** | — |

ПКМ в редакторе → **Hermes: Ask about this**. ПКМ по табу файла → **Hermes: Attach active file**.

## Как работает редактирование файлов

Когда ты просишь агента поменять файл, он отвечает структурированными блоками:

````
~~~hermes-edit path=src/foo.ts mode=replace
<полное новое содержимое>
~~~
````

Режимы: `replace` · `create` · `delete`. Пути относительно корня workspace.

Расширение парсит блоки и для каждого рисует **карточку Review** в чате. Клик на *Review* → side-by-side diff в VS Code → модальное окно Apply/Reject.

В режиме **Auto-edit** карточки применяются мгновенно. В режиме **Plan** агент сначала пишет нумерованный план и ждёт твоего ответа *go* / *yes* / *proceed* — только после этого можно применять правки.

## Сборка из исходников

```bash
git clone https://github.com/maksimryzhov614/hermes-vscode.git
cd hermes-vscode
npm install
npm run build               # esbuild → out/extension.js
npx vsce package            # → hermes-vscode-<версия>.vsix
code --install-extension hermes-vscode-<версия>.vsix --force
```

## Релизы

Workflow `release.yml` собирает и публикует Release при каждом теге `v*.*.*`:

```bash
# забампи version в package.json, потом:
git tag v0.9.4
git push origin main --tags
```

GitHub Actions сам соберёт `.vsix` и приложит к новому Release с авто-генерируемыми release-notes.

## Структура репо

```
hermes-vscode/
├── src/                      VSCode-расширение (TypeScript)
├── bridge/                   серверная часть (см. bridge/README.md)
│   ├── bridge.py             aiohttp-сервис
│   ├── .env.example          конфиг
│   └── hermes-bridge.service systemd unit
├── .github/workflows/
│   └── release.yml           CI: тег → сборка → Release с .vsix
├── media/icon.svg
├── package.json
└── README.md                 (этот файл)
```

## Лицензия

[MIT](./LICENSE) — © 2026 lildebil
