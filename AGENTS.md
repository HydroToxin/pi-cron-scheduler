# AGENTS.md

Guidance for AI coding agents working on this pi extension.

## Context

This is a **pi extension** — loaded by the pi coding agent at runtime. It has no build step; TypeScript is compiled on-the-fly by pi's extension runner.

Entry point: `index.ts` → exports a default function `cronSchedulerExtension(pi: ExtensionAPI)`.

## Critical Constraints

### Stale Context

Pi extensions receive an `ExtensionContext` (aka `ctx`) that becomes **stale** after `ctx.newSession()`, `ctx.fork()`, `ctx.switchSession()`, or `ctx.reload()`. Never capture `ctx` in long-lived closures (intervals, timeouts) without clearing and recreating them on each `session_start`.

**Pattern:** Always clear old intervals on `session_start`, then create fresh ones with the new `ctx`. Wrap `ctx.ui` access in try/catch as defense-in-depth.

```ts
pi.on("session_start", (_event, ctx) => {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  schedulerInterval = setInterval(() => checkAndRunJobs(ctx), 60000);
});
```

### No Build Step

There is no `tsconfig.json`, no `npm build`, no bundler. Pi loads the `.ts` file directly. All imports must be resolvable at runtime (Node.js ESM mode).

### External Dependencies

- **msg-gateway Daemon** (`http://127.0.0.1:3034`) — must be running for reports to deliver. Check with `isDaemonRunning()` before sending.
- **GitHub API** — unauthenticated, rate-limited (60 req/h). Cache fallback is `getCachedGitHubRepos()`.
- **DuckDuckGo HTML** — parsed from raw HTML, fragile. If DDG changes markup, `parseDDGResults()` breaks.

## Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Extension entry — commands, tool, scheduler loop |
| `package.json` | Pi package metadata (`pi.extensions` → `./index.ts`) |
| `.pi/` | Runtime data (gitignored) |

## Extension API Surface Used

- `pi.on("session_start", handler)` — init scheduler intervals
- `pi.on("session_shutdown", handler)` — cleanup intervals
- `pi.registerCommand(name, { handler, ... })` — `/cron`, `/morning-report`
- `pi.registerTool({ name, execute })` — `generate-morning-report` tool
- `ctx.ui.setStatus(namespace, text)` — status bar
- `ctx.ui.notify(message, level)` — in-chat notifications

## Daemon Protocol

```
POST /send  { platform: "discord"|"telegram", message: string }
GET  /status
```

Response: `{ success: boolean }` or `{ discord: boolean, telegram: boolean }`.

## Testing Changes

1. Make changes to `index.ts`
2. Reload pi extensions (`/reload` or restart pi)
3. Run `/cron status` to verify daemon connectivity
4. Run `/cron now` to test full report pipeline
