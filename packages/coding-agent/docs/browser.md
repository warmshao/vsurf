# Browserd: Shared Browser Daemon

Browserd is the host-side browser layer (`src/core/browser/`) that gives every agent tab-level access to one shared real browser over a single Chrome DevTools Protocol (CDP) connection. It is internal infrastructure: agents interact with it through the `browser` skill in the IPython kernel, never directly.

## Components

- **`BrowserManager`** — the process-wide singleton (one per host process, created lazily on first browser use). It owns the CDP connection(s) and a single authoritative map of tab ownership. Every operation validates ownership; seats are taken before any await, and `targetDestroyed` releases automatically.
- **`CdpClient`** — the raw CDP websocket client, plus HTTP discovery of attachable browsers (`/json/version`).
- **Connection provider** — orchestrates how the connection is obtained (see below).
- **Browser launcher** — finds a system Chrome/Edge/Brave/Chromium, or downloads Chrome for Testing via `@puppeteer/browsers`, and launches a managed instance.
- **Host handlers** — expose browser operations (navigate, screenshot, click, DOM, JS evaluation) to the Python kernel.

## Connection Order

On first use, the connection provider tries, in order:

1. **`VSURF_BROWSER_CDP_URL` env override** — always wins, skips any prompt. Intended for headless/CI.
2. **Persisted preference** — the user's saved choice (`attach` / `launch` / `endpoint` in settings).
3. **Silent discovery** — if exactly one already-debuggable browser is found, connect without asking (the `chrome://inspect` remote-debugging checkbox is sticky, so this often just works).
4. **First-use prompt** — interactive sessions list attachable running browsers by name, launchable installed binaries, a manual CDP endpoint, or a managed download. The choice is persisted.
5. **Headless fallback** — launch a managed browser silently.

An explicit `browser.reconnect()` forces the prompt again regardless of what is persisted.

## Attach vs. Managed

- **Attach** drives the user's everyday browser *with its logins*, but requires remote debugging to be enabled first (`chrome://inspect` checkbox, or `--remote-debugging-port` with a dedicated `--user-data-dir` — Chrome 136+ ignores the port flag on the default profile). Chrome 144+ shows a one-time consent dialog per tab attach.
- **Managed launch** spawns a separate instance with an ephemeral debugging port and a dedicated profile under the agent directory (`browser-profile/`). Popup-free, but a clean profile with no user logins. Only one managed instance exists per host process; it is reused across reconnects and killed on host exit.

## Tab Ownership Model

- Each agent is assigned its own tabs and only ever sees them. Agent-created tabs are closed when the agent's session ends.
- The main agent (RLM depth 0) may list and adopt the user's own tabs; adopted tabs are released on detach, never closed. Child agents cannot adopt — they only get fresh tabs.
- Each agent has a logical focus tab that targetless operations hit. Focus is never brought to the front: everything runs on background tabs without disturbing the user.
- Per-agent quota: at most 5 tabs.
- Different agents may be bound to different browser connections at the same time (e.g. one on the user's Chrome, a child on the managed browser); reconnecting one never disturbs the others.

## Settings

The persisted preference lives under the `browser` key in global settings:

```json
{
  "browser": { "mode": "attach", "attachLabel": "Google Chrome" }
}
```

| Field | Values |
| --- | --- |
| `mode` | `"attach"` \| `"launch"` \| `"endpoint"` |
| `cdpUrl` | HTTP endpoint for `endpoint` mode (e.g. `http://127.0.0.1:9222`) |
| `binaryPath` | Explicit browser executable for `launch` mode |
| `attachLabel` | Remembered browser name for `attach` mode |

## Errors

Operations return structured error codes: `NOT_CONNECTED`, `NOT_OWNER`, `TARGET_NOT_FOUND`, `TAB_DESTROYED`, `QUOTA_EXCEEDED`, `ADOPT_NOT_ALLOWED`, `CDP_ERROR`. Agents are instructed to treat them as recoverable (e.g. open a new tab on `TAB_DESTROYED`).

For the agent-facing API and usage guidance, see the `browser` skill (`skills/browser/SKILL.md`).
