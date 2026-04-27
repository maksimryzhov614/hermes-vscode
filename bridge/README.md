# hermes-bridge

Тонкий aiohttp-сервис, который стоит между VS Code-расширением и встроенным `api_server`-плагином [Hermes Agent](https://github.com/NousResearch/hermes-agent). Делает три вещи:

1. **Pairing через Telegram-бота** (`/pair/init`, `/pair/poll`, `/pair/approve`) — выпускает per-client bearer-токены без копи-пасты
2. **OpenAI-совместимый прокси** на `/v1/*` — пользователь стучится своим токеном, bridge подменяет его на мастер-ключ `API_SERVER_KEY` и передаёт запрос дальше
3. **Безопасность**: rate-limit, TTL токенов (90д), revoke-эндпоинт, аудит-лог в SQLite

## Архитектура

```
VS Code ext  ──HTTPS──►  hermes-bridge :8643  ──HTTP──►  hermes api_server :8642
                              │
                              └──► Telegram Bot API
                                   (Approve link для нового клиента)
```

## Зачем оно нужно

Hermes Agent сам по себе слушает локальный порт 8642 с одним мастер-ключом `API_SERVER_KEY`. Раздавать этот ключ всем устройствам неудобно и небезопасно. Bridge превращает один ключ в много персональных токенов, которые можно ревокать индивидуально, и упрощает онбординг — новый клиент просто получает Telegram-сообщение с кнопкой Approve.

## Что нужно для запуска

- **Hermes Agent** установлен и в `~/.hermes/.env` есть:
  - `API_SERVER_ENABLED=1`
  - `API_SERVER_KEY=<длинная случайная строка>`
  - `API_SERVER_HOST=127.0.0.1`
  - `API_SERVER_PORT=8642`
  - `TELEGRAM_BOT_TOKEN=<токен бота>`
  - `TELEGRAM_HOME_CHANNEL=<твой Telegram user id>`
- **Python 3.11+** с пакетом `aiohttp` (если используешь venv hermes — он там уже есть)
- **HTTPS-доступ снаружи** (Cloudflare Tunnel / Tailscale Funnel / Caddy на VPS — что угодно)

## Установка

```bash
# 1. Скопируй файлы в любую папку (примеры — в /home/dev/hermes-bridge/)
mkdir -p ~/hermes-bridge && cd ~/hermes-bridge
cp /path/to/this/repo/bridge/bridge.py .
cp /path/to/this/repo/bridge/.env.example .env

# 2. Поправь .env под себя — главное BRIDGE_PUBLIC_URL должен быть твоим внешним HTTPS
$EDITOR .env

# 3. Запуск (используй Python из hermes venv — там уже установлен aiohttp)
~/.hermes/hermes-agent/venv/bin/python bridge.py
```

Проверь:
```bash
curl http://localhost:8643/health
# {"status": "ok", "service": "hermes-bridge"}
```

## Автозапуск через systemd

```bash
sudo cp /path/to/this/repo/bridge/hermes-bridge.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-bridge
sudo systemctl status hermes-bridge
```

(Юнит ожидает что bridge.py лежит в `/home/dev/hermes-bridge/` и Python — в hermes venv. Поправь пути если у тебя по-другому.)

## Как сделать публичным

Bridge должен быть доступен снаружи по HTTPS, чтобы Telegram-ссылка работала с телефона. Самые простые варианты:

### Вариант 1: Cloudflare Tunnel (бесплатно, без публичного IP)

```bash
sudo apt install cloudflared
cloudflared tunnel login
cloudflared tunnel create hermes-bridge
cloudflared tunnel route dns hermes-bridge hermes.твойдомен.ru
```

В `/etc/cloudflared/config.yml`:
```yaml
tunnel: <id-твоего-туннеля>
credentials-file: /home/<user>/.cloudflared/<id>.json
ingress:
  - hostname: hermes.твойдомен.ru
    service: http://localhost:8643
  - service: http_status:404
```

Запуск как сервис:
```bash
sudo cloudflared service install
```

### Вариант 2: Tailscale Funnel

```bash
tailscale funnel 8643
```
Получишь URL вида `https://<твой-узел>.<tail-id>.ts.net` — без своего домена.

### Вариант 3: Caddy + публичный IP/VPS

```caddy
hermes.example.com {
    reverse_proxy localhost:8643
}
```

## Эндпоинты

| Endpoint | Метод | Назначение |
|---|---|---|
| `/health` | GET | health-check (без auth) |
| `/pair/init` | POST | начать pairing — bridge посылает Telegram-сообщение с Approve-ссылкой |
| `/pair/poll` | POST | клиент опрашивает статус кода — получает токен после approve |
| `/pair/approve` | GET | URL из Telegram-сообщения — пользователь тапает, bridge выдаёт токен |
| `/pair/revoke` | POST | клиент сам сжигает свой токен (Bearer) |
| `/pair/audit` | GET | последние 50 операций по своему токену (Bearer) |
| `/v1/*` | * | прокси на api_server, требует Bearer-токен |

## Безопасность

- **Токены `hbk_…`** — 48 hex-символов, TTL по умолчанию **90 дней**, можно ревокать через `/pair/revoke` или sign-out в расширении
- **Rate-limit** на `/pair/init` — **5 запросов на IP за 10 минут**, чтобы утечка URL не вылилась в спам Telegram-сообщений
- **CSRF в approve-ссылках** — каждая ссылка содержит уникальный `csrf` параметр, проверяется через `secrets.compare_digest`
- **Audit-лог** пишется в SQLite (`bridge.db`) — каждый `/v1/*` хит фиксируется с префиксом токена и IP

## Файлы данных

- `bridge.db` — SQLite со всеми токенами, pair_codes, rate_limit, audit_log. Резервируй регулярно
- `bridge.log` — общий лог (если запущено через systemd с `StandardOutput=append:`)

Удаление `bridge.db` сбросит все pairing'и — клиентам придётся пройти Approve заново.

## Лицензия

[MIT](../LICENSE) — © 2026 lildebil
