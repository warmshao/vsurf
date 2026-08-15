# vsurf

**vsurf** is a browser-first coding agent. It runs terminal coding agents with an IPython-backed runtime, and gives every agent its own browser tab - one shared browser, many agents surfing in parallel.

## Why vsurf

Most coding agents live in the terminal. vsurf also lives in the browser:

- **One browser, many agents** - a single Chrome/Edge/Chromium instance is shared over one CDP connection; each RLM agent gets its own tab, sees only its own tabs, and its tabs are released when the session ends.
- **Parallel agent execution** - run multiple agents at the same time, each driving its own tab in the same browser, without window sprawl or profile conflicts.
- **Screenshot-first browsing** - vision models act by screenshot + coordinate clicks (works through iframes and shadow DOM); text-only models fall back to `dom()` + indexed clicks.
- **Persistent IPython kernel** - agents execute code in a managed kernel with memory, skills, and the shared browser module.

## Getting Started

Requires Node.js >= 22.8.0 and (for the browser module) a local Chrome, Edge, or managed Chromium.

```bash
npm install
npm run build
node packages/coding-agent/dist/bundle/cli.js
```

For development, run from source without a build:

```bash
npx tsx packages/coding-agent/src/cli.ts
```

On first launch, run `/login` to configure a provider.

## Browser Automation

The browser feature is built in. Each agent can:

```python
await browser.ensure_session()          # connect to the shared browser
await browser.goto_url("https://example.com")
await browser.screenshot()              # vision models: look first
await browser.click_at_xy(x, y)         # coordinate clicks pass through iframes
```

- Each agent is isolated to its own tabs.
- Adopt the user's existing tabs when needed (auto-adopt supported).
- Tabs are closed automatically when the agent session ends.
- One browser serves all agents concurrently - every agent is a tab.

## Architecture

- `packages/coding-agent` - CLI, daemon, interactive TUI, session management
- `packages/ai` - provider integrations and model catalog
- `packages/agent` - agent loop
- `packages/tui` - terminal UI toolkit
- `vsurf-runtime` - Python RLM runtime (IPython kernel side)
- `packages/coding-agent/src/core/browser` - CDP connection manager, per-agent tab ownership, browser host integration

## Development

```bash
npm install
npm run check
```

User configuration lives under `~/.vsurf/agent/`. Project-local settings live under `.vsurf/agent/`.

## License

MIT

---

Built on [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).