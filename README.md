# pi-cron-scheduler

Cron Scheduler Extension for [pi](https://github.com/mariozechner/pi-coding-agent) — manages scheduled tasks and generates AI Morning Reports delivered via Discord/Telegram.

## Features

- **Scheduled Tasks** — Register cron jobs (`morning-report`, `custom`, `search`) with 5-field cron expressions
- **AI Morning Report** — Daily report (default 07:00) with:
  - 🚀 Top 5 Trending AI GitHub Repositories
  - 🧠 New AI Models (last 24h)
  - 💰 Cheap Providers & Free Models
  - 🔥 Top 5 Hype & Trends
- **Live Web Search** — DuckDuckGo-based, no API key required
- **Discord / Telegram Delivery** — via [msg-gateway Daemon](https://github.com/HydroToxin/msg-gateway)
- **Status Bar Integration** — Shows next scheduled run in the pi status bar

## Requirements

- [msg-gateway Daemon](https://github.com/HydroToxin/msg-gateway) running on `http://127.0.0.1:3034`

## Commands

| Command | Description |
|---------|-------------|
| `/cron list` | Show all cron jobs |
| `/cron status` | Extension health, daemon status |
| `/cron now` | Trigger Morning Report immediately |
| `/cron add <name> <schedule> <action>` | Register new job |
| `/cron remove <id\|name>` | Remove a job |
| `/cron enable <id\|name>` | Enable a disabled job |
| `/cron disable <id\|name>` | Disable a job |
| `/cron test [name]` | Test-run one or all enabled jobs |
| `/cron config time <HH:MM>` | Change Morning Report schedule |
| `/morning-report` | Shortcut: generate & send report now |

### Tool

| Tool | Description |
|------|-------------|
| `generate-morning-report` | Exposed as a pi tool for use in prompt templates / automation |

## Schedule Format

Standard 5-field cron: `minute hour day-of-month month day-of-week`

```
0 7 * * *     → daily at 07:00
30 8 * * 1    → Mondays at 08:30
0 */6 * * *   → every 6 hours
```

## Data Storage

- `~/.pi/cron-scheduler/jobs.json` — job definitions and run history
- `~/.pi/cron-scheduler/report-cache.json` — cached report data as fallback

## Architecture

```
pi session_start → creates schedulerInterval (60s tick) + statusInterval (5min tick)
                  ↓
           checkAndRunJobs()
                  ↓
          runMorningReport()
          ├── isDaemonRunning()
          ├── buildMorningReport()
          │   ├── fetchGitHubTrending()  → api.github.com
          │   └── webSearch()            → html.duckduckgo.com
          └── sendToDaemon()             → localhost:3034
```

## License

MIT
