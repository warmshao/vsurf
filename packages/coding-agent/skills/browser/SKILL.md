---
name: browser
description: Control a shared real browser (the user's own Chrome/Edge or a managed Chromium) from the kernel. Each agent only sees its own tabs. Use for browsing, automation, scraping, form filling, and page QA. Screenshot-first for vision models; dom()+click_index for text-only models.
---

# Browser

Control a real browser from the IPython kernel. The host owns the single CDP
connection and assigns tabs per agent — you only ever see your own tabs, and
your tabs are closed automatically when your session ends (tabs you adopted
from the user are only released, never closed).

Call the prepared `browser` import directly; every function is async:

```python
await browser.ensure_session()                 # first call connects (may prompt the user once)
await browser.goto_url("https://example.com")
await browser.screenshot()                     # look before you act
```

## What actually works

- **Screenshots first (default path)**: `await browser.screenshot()` to
  understand the page, find targets, and verify every meaningful action.
  Re-screenshot after acting instead of assuming it worked. If the model you
  are running on can see images, ALWAYS prefer screenshot + coordinates over
  DOM probing.
- **Clicking**: read the pixel off the screenshot → `click_at_xy(x, y)` →
  screenshot to verify. Coordinate clicks pass through iframes, shadow DOM,
  and cross-origin content at the compositor level — don't hunt selectors first.
  `screenshot()` returns `image {w,h}` (the attached, possibly downscaled
  picture) and `viewport_css {w,h,dpr}` (what `click_at_xy` expects). Convert:
  `css = image_coord * viewport_css.w / image.w` (same for y with h).
- **Text-only models ONLY**: if `screenshot()` returns `vision_unsupported`,
  switch to `dom()` → indexed element list → `click_index(i)` /
  `fill_index(i, text)`. On vision models, do NOT use dom() as your default
  exploration tool. Re-run `dom()` after navigation or big page changes;
  indexes go stale. dom() covers the FULL page; entries marked [below-fold]
  are off-screen — click_index scrolls to them automatically. Each line also
  carries the element's center as `@(x, y)` in CSS pixels (usable with
  `click_at_xy` directly), and `text_content` lists the page's readable
  non-interactive text (headings, paragraphs, list/table text) in document
  order — read it there before falling back to js() for content extraction.
- **DOM reads**: `await browser.js("...")` for inspection and extraction.
  Top-level `return` works; promises are awaited. Don't read small text off
  screenshots.
- **Large pages — grep dom() output first, don't dump it**: bind the result
  to a variable and search it with `grep_dom`, which works like `grep -i -C`:
  matching lines plus context, nothing else.

  ```python
  d = await browser.dom(200)
  print(browser.grep_dom(d, r"checkout|cart"))                 # elements_text
  print(browser.grep_dom(d, r"price", field="text_content"))   # readable text
  ```

  The full dict stays live in the kernel — nothing is thrown away. If grep
  finds nothing, the element may use different wording (or be beyond
  `max_elements`): try other patterns first, then page through the whole
  thing in chunks rather than assuming it's absent:

  ```python
  lines = d["elements_text"].splitlines()
  print("\n".join(lines[:80]))    # then lines[80:160], ... as needed
  ```
- **Forms**: `fill_input(selector, text)` (or `fill_index(i, text)`), then
  `press_key("enter")`. Trusted input events drive React/Vue controlled inputs.
- **After goto**: `await browser.js("return document.readyState")` or a short
  `asyncio.sleep`, then screenshot.
- **Scrolling**: `scroll(dy=600)` scrolls down, `scroll(dy=-600)` up. It's
  JS-based and works on background tabs; pass x/y to scroll a specific panel.
- **Troubleshooting**: `drain_events()` shows network/page lifecycle events;
  `page_info()` is the cheapest "is this tab alive?" check. `page_info()`
  reports YOUR focused tab — it never tells you which tab the user is
  looking at (that is the `active` marker from `list_tabs(scope="all")`),
  and it fails with `[NOT_CONNECTED]` when you have no tab yet instead of
  creating one.
- **Raw CDP**: `await browser.cdp("Domain.method", {...})` for anything the
  helpers don't cover (e.g. `Accessibility.getFullAXTree`).
- **Switching browsers**: if the user asks to use a different browser, call
  `await browser.reconnect()` — the user gets the connection choices again.

## Using the user's already-running local browser

When the user asks how to make the agent drive THEIR browser (with their
logins), that browser must expose a CDP endpoint first. Give them ONE of
these setups, then call `await browser.reconnect()` and have them pick
"Use my RUNNING <browser>" from the list:

- **Easiest (Chrome/Edge/Brave, one-time)**: in that browser open
  `chrome://inspect/#remote-debugging` and tick **Allow remote debugging**.
  The checkbox is sticky — do it once and the browser is discoverable on
  every later launch. No restart needed. This is the ONLY way to attach to
  the browser's everyday profile with its logins.
- **Alternative (separate profile)**: launch the browser with
  `--remote-debugging-port=9222 --user-data-dir=/some/dedicated/dir`, then
  pick "Enter a CDP endpoint manually" with `http://127.0.0.1:9222` on
  reconnect. Note: Chrome 136+ silently IGNORES the port flag on the
  default profile — a dedicated user-data-dir is mandatory, which means
  this path never has the user's logins.
- **Headless/CI or scripting**: set the env var
  `VSURF_BROWSER_CDP_URL=http://127.0.0.1:9222` before starting the
  agent — it always wins and skips the picker entirely. Same user-data-dir
  caveat applies to whatever that endpoint points at.

A running browser that has NOT done one of the above is invisible to the
agent — it will not appear in the picker. If the user insists their browser
is running but no "RUNNING" option shows up, the debugging checkbox/port
is the missing step.

Attaching to a tab may pop Chrome's modal "Allow remote debugging" dialog
— once per tab (attaches are serialized internally, so only one dialog
appears at a time; sessions are cached afterwards). If the browser seems
frozen, a dialog is probably waiting on another monitor or macOS Space.

## Tabs you own vs tabs the user owns

- `ensure_session()` / `new_tab(url)` create fresh tabs assigned to you. A new
  tab automatically becomes your **focused tab**: all targetless calls act on
  it. Use `focus_tab(target_id)` to switch context between your tabs, or pass
  `target_id=` explicitly to any call. `list_tabs()` marks yours with
  `focused: true`. Focus is never brought to the front — everything runs in
  the background without disturbing the user.
- `list_tabs()` shows only your tabs. The **main agent** may also
  `list_tabs(scope="all")` to see the user's open tabs — tabs the user is
  looking at come back marked `active: true` (with several browser windows
  open, EACH window's front tab is marked — CDP does not expose which
  window is frontmost, so pick by context or ask the user) — and work on
  any of them directly: passing a user tab's `target_id` to any operation
  adopts it on the fly (or call `attach_tab(target_id)` explicitly) — e.g.
  when the user asks to "summarize the page I have open". Adopted tabs are
  never closed by the agent lifecycle. Child agents cannot adopt.
  On Chrome 150+ the active marker needs no attaches at all; on older
  Chrome the first probe of a user tab may show the one-time consent
  dialog (cached afterwards). If the result carries an
  `active_detection_note`, some tabs could not be probed — relay it to
  the user.
  Responses carry a `browser` field naming which browser you are connected
  to. If it says "managed browser", the user's tabs are NOT there — call
  `reconnect()` and let the user pick their running browser.
- You get at most 5 tabs; `close_tab()` ones you're done with.
- Errors are structured: `[NOT_OWNER]`, `[TAB_DESTROYED]`, `[QUOTA_EXCEEDED]`,
  `[ADOPT_NOT_ALLOWED]`, `[STALE_INDEX]`, `[NOT_CONNECTED]`,
  `[TARGET_NOT_FOUND]`, `[CDP_ERROR]`. On `TAB_DESTROYED` just open a new
  tab; on `STALE_INDEX` re-run `dom()`.

## Gotchas

- **Auth wall**: redirected to a login page → stop and ask the user. Never
  type credentials.
- First use may prompt the user to pick a connection mode (their running
  browsers are listed by name — Chrome/Edge/Brave — plus launching a managed
  one or a custom endpoint). Their choice is persisted; later calls connect
  silently. Only ALREADY-DEBUGGABLE browsers appear in the list — see
  "Using the user's already-running local browser" above when the user asks
  how to connect their own browser.
- Coordinates are CSS pixels in the viewport — exactly what `dom()`'s
  `@(x, y)` markers and `page_info()` report. Screenshots may be downscaled;
  use the `image`/`viewport_css` sizes from `screenshot()`'s return value to
  convert (see Clicking above).
- Don't activate/focus tabs; everything works on background tabs.
