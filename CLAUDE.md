# Tact

Telegram bot that runs Claude Code as a personal assistant.

## Tech Stack

- TypeScript, Node.js 18+
- Grammy (Telegram bot framework)
- Pino (logging)
- Zod (config validation)
- Biome (linting/formatting)
- pnpm (package manager)

## Commands

```bash
pnpm run dev       # Development with hot reload
pnpm run build     # Compile TypeScript
pnpm run lint      # Check linting and formatting
pnpm run lint:fix  # Fix linting and formatting
```

## Project Structure

- `src/cli.ts` - CLI entry point
- `src/bot.ts` - Bot initialization, Grammy middleware setup
- `src/config.ts` - Configuration loading (tact.config.json + env vars)
- `src/constants.ts` - Shared constants (TELEGRAM_MAX_LENGTH = 4096)
- `src/bot/handlers/` - Message handlers (text, photo, document, voice)
- `src/bot/commands/` - Bot commands (/start, /help, /clear, /restart, /think)
- `src/claude/` - Claude Code CLI integration (executor, parser, streaming)
- `src/user/` - User session management (session ID persistence, paths)
- `src/telegram/` - Telegram utilities (chunker splits long messages, fileSender sends downloads)
- `src/webhook/` - Inbound webhook server + JSON file queue with lock mutex
- `src/notification/` - Outbound notification queue (SQLite-backed, polled every 12s)

## Key Patterns

- Config loaded from `tact.config.json` with env var overrides
- User data stored in `.tact/users/{userId}/` (uploads/, downloads/, session file)
- Claude runs as subprocess; streaming JSON output parsed for progress updates
- Outbound messages go through SQLite notification queue (enqueue → poll → send)
- Inbound webhook messages go through JSON file queue with file-lock mutex
- Long messages split via `chunkMessage()` from `src/telegram/chunker.ts`
- Upload filenames use `randomUUID()` prefix to prevent collisions
- Session-start hook loads `Vault/memory/core.md` + `tasks.md` on every new Claude session

## Service Management

- macOS (quint): `launchctl kickstart -k gui/$(id -u)/com.sfallows.tact`
  - Plist: `~/Library/LaunchAgents/com.sfallows.tact.plist`
  - Logs: `~/Library/Logs/tact.log`
- Linux (brush): `systemctl restart tact`
- `/restart` command handles platform detection automatically
