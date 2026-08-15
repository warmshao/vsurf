/**
 * browser.* host handlers: the kernel-facing observation/action surface.
 *
 * Every handler is a thin adapter: validate payload → route through
 * BrowserManager (which enforces ownership + per-target locking) → return
 * plain JSON. Errors are thrown as `[CODE] message` so the Python shim can
 * surface structured failures through the comm bridge.
 *
 * API philosophy (browser-harness): screenshot-first, coordinate clicks, js()
 * for DOM reads, raw cdp() as the universal escape hatch. The dom()/click_index
 * path exists for text-only models; its element filtering distills browser-use's
 * clickable_elements.py heuristics into one Runtime.evaluate snippet.
 */

import type { HostRequestHandlers } from "../kernel/index.js";
import { BrowserError, type BrowserManager } from "./browser-manager.js";

export interface BrowserHostHandlerDeps {
	manager: BrowserManager;
	agentId: string;
	rlmDepth: number;
	/** Whether the session's current model accepts image input. */
	modelSupportsVision: () => boolean;
	/** Clear the persisted browser preference so the next connect re-prompts. */
	resetConnectionPreference?: () => void;
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function requireString(payload: Record<string, unknown>, key: string): string {
	const value = payload[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`${key} must be a non-empty string`);
	}
	return value;
}

function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`${key} must be a string`);
	}
	return value;
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
	const value = payload[key];
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${key} must be a finite number`);
	}
	return value;
}

function optionalNumber(payload: Record<string, unknown>, key: string, fallback: number): number {
	const value = payload[key];
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${key} must be a finite number`);
	}
	return value;
}

function rethrow(err: unknown): never {
	if (err instanceof BrowserError) {
		throw new Error(`[${err.code}] ${err.message}`);
	}
	throw err;
}

// ---------------------------------------------------------------------------
// DOM extraction snippet (text-model path)
// Filtering order distilled from browser-use clickable_elements.py:
// interactive tags → ARIA roles → tabindex/on* attrs → label[for] exclusion →
// cursor:pointer fallback. Visibility adds a cheap elementFromPoint occlusion
// check (browser-use paint_order.py's 80/20). Coordinates are CSS pixels —
// the same space Input.dispatchMouseEvent expects.
// ---------------------------------------------------------------------------

const DOM_SNAPSHOT_JS = `(function (maxElements) {
	// Clear markers from any previous dom() run; they are our re-location handles.
	const MARK = "data-pa-el";
	for (const stale of document.querySelectorAll("[" + MARK + "]")) stale.removeAttribute(MARK);

	// --- predicate set distilled from browser-use's two generations of DOM code:
	// 0.1.48 buildDomTree.js ("cursor-first is the genius fix") and current
	// clickable_elements.py (tag/role order, label[for] exclusion) ---
	const INTERACTIVE_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "DETAILS", "SUMMARY", "OPTION"]);
	const INTERACTIVE_ROLES = new Set(["button", "link", "menuitem", "menuitemradio", "menuitemcheckbox", "option", "radio", "checkbox", "tab", "textbox", "combobox", "slider", "spinbutton", "listbox", "search", "searchbox", "switch"]);
	// buildDomTree.js: computed cursor is the single best interactivity signal
	// (covers React/Vue delegated handlers that leave no attribute trace).
	const INTERACTIVE_CURSORS = new Set(["pointer", "move", "text", "grab", "grabbing", "cell", "copy", "alias", "all-scroll", "col-resize", "row-resize", "context-menu", "crosshair", "help", "vertical-text", "zoom-in", "zoom-out", "e-resize", "w-resize", "n-resize", "s-resize", "ne-resize", "nw-resize", "se-resize", "sw-resize", "ew-resize", "ns-resize", "nesw-resize", "nwse-resize"]);
	const NON_INTERACTIVE_CURSORS = new Set(["not-allowed", "no-drop", "wait", "progress"]);

	const styleCache = new WeakMap();
	function styleOf(el) {
		let s = styleCache.get(el);
		if (!s) { s = getComputedStyle(el); styleCache.set(el, s); }
		return s;
	}
	function textOf(el) {
		const aria = el.getAttribute("aria-label");
		if (aria) return aria.trim().slice(0, 80);
		const ph = el.getAttribute("placeholder");
		if (ph) return ph.trim().slice(0, 80);
		const alt = el.getAttribute("alt");
		if (alt) return alt.trim().slice(0, 80);
		// GitHub-style icon buttons name themselves via aria-labelledby references.
		const labelledBy = el.getAttribute("aria-labelledby");
		if (labelledBy) {
			const named = labelledBy.split(/\\s+/)
				.map((id) => { const ref = document.getElementById(id); return ref ? ref.textContent : ""; })
				.join(" ").trim().replace(/\\s+/g, " ");
			if (named) return named.slice(0, 80);
		}
		// Never leak password field values into model context (browser-use
		// serializer.py does the same): prompt injection could exfiltrate them.
		const isPassword = el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password";
		return (el.innerText || (!isPassword && el.value) || el.getAttribute("title") || "").trim().replace(/\\s+/g, " ").slice(0, 80);
	}
	function isVisible(el, rects) {
		if (!rects || rects.length === 0) return false;
		// Chrome 105+: handles display/visibility/opacity/content-visibility in one call.
		if (el.checkVisibility) {
			try { return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }); } catch { /* fall through */ }
		}
		const style = styleOf(el);
		if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
		if (Number.parseFloat(style.opacity) === 0) return false;
		return true;
	}
	function isDisabled(el) {
		return !!(el.disabled || el.readOnly || el.inert ||
			el.hasAttribute("disabled") || el.hasAttribute("readonly") || el.hasAttribute("inert") ||
			el.getAttribute("aria-disabled") === "true" || el.getAttribute("aria-hidden") === "true");
	}
	function isInteractive(el, tag, role, style) {
		if (INTERACTIVE_TAGS.has(tag)) {
			// Form controls with a "blocked" cursor are visually present but dead.
			return !NON_INTERACTIVE_CURSORS.has(style.cursor);
		}
		if (tag === "LABEL") {
			// label[for] proxies to its control — skip to avoid double activation.
			return !el.getAttribute("for") && !!el.querySelector("input, select, textarea");
		}
		if (tag === "IFRAME") return false; // handled separately by size
		// Cursor-first: the strongest signal for framework-rendered widgets.
		if (INTERACTIVE_CURSORS.has(style.cursor)) return true;
		if (el.isContentEditable || el.getAttribute("contenteditable") === "true") return true;
		if (INTERACTIVE_ROLES.has(role)) return true;
		// Dropdown/component hints (buildDomTree.js).
		if (el.getAttribute("aria-haspopup") === "true" || el.getAttribute("data-toggle") === "dropdown" ||
			el.hasAttribute("data-index") || (el.classList && (el.classList.contains("button") || el.classList.contains("dropdown-toggle")))) return true;
		if (el.hasAttribute("onclick") || el.hasAttribute("onmousedown") || el.hasAttribute("tabindex")) return true;
		return false;
	}

	const vw = window.innerWidth, vh = window.innerHeight;
	const candidates = document.querySelectorAll(
		"a, button, input, select, textarea, details, summary, option, [role], [tabindex], [onclick], [contenteditable], [aria-haspopup], label, iframe"
	);
	const elements = [];
	const listed = new Map(); // element → rect, for ancestor-containment dedupe
	let index = 0;
	let totalInteractive = 0;
	for (const el of candidates) {
		const tag = el.tagName;
		const rects = el.getClientRects();
		if (!isVisible(el, rects)) continue;
		if (isDisabled(el)) continue;
		const style = styleOf(el);
		if (style.pointerEvents === "none") continue;
		const role = el.getAttribute("role") || "";
		const rect = el.getBoundingClientRect();
		let kind = null;
		if (tag === "IFRAME") {
			// Large frames may need scrolling; small ones are decorative.
			if (rect.width > 100 && rect.height > 100) kind = "iframe";
		} else if (isInteractive(el, tag, role, style)) {
			kind = "interactive";
		}
		if (!kind) continue;
		// Ancestor-containment dedupe (browser-use bounding-box propagation,
		// simplified): a candidate fully inside an already-listed interactive
		// ancestor (e.g. a pointer-cursor span inside a button) is redundant —
		// unless it needs individual interaction: form controls, onclick,
		// aria-label, or an interactive role/tag of its own.
		if (kind === "interactive") {
			let covered = false;
			for (let p = el.parentElement; p; p = p.parentElement) {
				const ar = listed.get(p);
				if (ar) {
					covered =
						rect.left >= ar.left - 1 && rect.top >= ar.top - 1 &&
						rect.right <= ar.right + 1 && rect.bottom <= ar.bottom + 1;
					break; // the nearest listed ancestor decides
				}
			}
			if (covered) {
				const keep =
					INTERACTIVE_TAGS.has(tag) || tag === "LABEL" ||
					el.hasAttribute("onclick") ||
					(el.getAttribute("aria-label") || "").trim() !== "" ||
					INTERACTIVE_ROLES.has(role);
				if (!keep) continue;
			}
		}
		totalInteractive++;
		// Full-page coverage: elements beyond the cap still count but aren't listed.
		if (elements.length >= maxElements) continue;
		const inView = !(rect.bottom < 0 || rect.right < 0 || rect.top > vh || rect.left > vw);
		// Occlusion (isTopElement): use the MIDDLE client rect — bounding-box
		// centers mis-hit on wrapped inline links. On-screen elements only.
		if (inView && rects.length > 0) {
			const mid = rects[Math.floor(rects.length / 2)];
			const cx = Math.round(mid.left + mid.width / 2);
			const cy = Math.round(mid.top + mid.height / 2);
			if (cx >= 0 && cy >= 0 && cx <= vw && cy <= vh) {
				const root = el.getRootNode();
				const fromPoint = root.elementFromPoint ? root.elementFromPoint(cx, cy) : document.elementFromPoint(cx, cy);
				if (fromPoint && fromPoint !== el && !el.contains(fromPoint) && !fromPoint.contains(el)) continue;
			}
		}
		const cx = Math.round(rect.left + rect.width / 2);
		const cy = Math.round(rect.top + rect.height / 2);
		el.setAttribute(MARK, String(index));
		listed.set(el, rect);
		elements.push({
			i: index++,
			tag: tag.toLowerCase(),
			role: role || undefined,
			type: tag === "INPUT" ? (el.getAttribute("type") || "text") : undefined,
			text: textOf(el),
			href: tag === "A" ? el.getAttribute("href") || undefined : undefined,
			kind,
			cx, cy,
			w: Math.round(rect.width),
			h: Math.round(rect.height),
			inView,
		});
	}
	// Non-interactive text nodes (browser-use includes TEXT_NODEs inline with
	// the same bar: visible + stripped length > 1). Headings/paragraphs/list/
	// table text carry the page's readable content. They get NO index and no
	// marker — read-only info. Text under an already-listed interactive or
	// text ancestor is skipped: it is already represented by that line.
	const capturedTexts = new Set();
	const texts = [];
	for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,td,th,dt,dd,blockquote,figcaption,pre,caption,legend")) {
		if (texts.length >= 60) break;
		let skip = false;
		for (let p = el.parentElement; p; p = p.parentElement) {
			if (capturedTexts.has(p) || listed.has(p)) { skip = true; break; }
		}
		if (skip) continue;
		const rects = el.getClientRects();
		if (!isVisible(el, rects)) continue;
		const text = (el.innerText || "").trim().replace(/\\s+/g, " ");
		if (text.length < 2) continue;
		// Skip when the text is entirely covered by already-listed interactive
		// DESCENDANTS too (e.g. <p><a>Learn more</a></p> — the link line has it).
		// Marked descendants only: unlisted elements can't represent the text.
		let residual = text;
		for (const desc of el.querySelectorAll("[" + MARK + "]")) {
			const lt = (desc.innerText || desc.value || "").trim().replace(/\\s+/g, " ");
			if (lt) residual = residual.replace(lt, " ");
		}
		if (residual.trim().length < 2) continue;
		const rect = el.getBoundingClientRect();
		capturedTexts.add(el);
		texts.push({
			tag: el.tagName.toLowerCase(),
			text: text.slice(0, 200),
			cx: Math.round(rect.left + rect.width / 2),
			cy: Math.round(rect.top + rect.height / 2),
			inView: !(rect.bottom < 0 || rect.right < 0 || rect.top > vh || rect.left > vw),
		});
	}
	// Scrollable containers: the model needs to know where scrolling works.
	const scrollables = [];
	for (const el of document.querySelectorAll("*")) {
		if (scrollables.length >= 10) break;
		if (el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 100) {
			const style = styleOf(el);
			if (/(auto|scroll)/.test(style.overflowY)) {
				const rect = el.getBoundingClientRect();
				if (rect.width > 50 && rect.height > 50) {
					scrollables.push({
						tag: el.tagName.toLowerCase(),
						text: (el.getAttribute("aria-label") || el.id || el.className.toString().split(" ")[0] || "").slice(0, 40),
						cx: Math.round(rect.left + rect.width / 2),
						cy: Math.round(rect.top + rect.height / 2),
					});
				}
			}
		}
	}
	return {
		url: location.href,
		title: document.title,
		viewport: { w: vw, h: vh, scrollY: Math.round(window.scrollY), pageHeight: Math.round(document.documentElement.scrollHeight) },
		elements,
		texts,
		scrollables,
		totalInteractive,
		truncated: totalInteractive > elements.length,
	};
})`;

/** Locate a dom()-marked element by index, scroll it into view, return its fresh viewport center. */
const LOCATE_MARKED_JS = `(function (mark, index) {
	const el = document.querySelector("[" + mark + '="' + index + '"]');
	if (!el) return null;
	if (el.scrollIntoViewIfNeeded) el.scrollIntoViewIfNeeded();
	else el.scrollIntoView({ block: "center", inline: "center" });
	const r = el.getBoundingClientRect();
	return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2), tag: el.tagName.toLowerCase() };
})`;

/**
 * Select the focused element's contents so the following insertText REPLACES
 * them. A keyboard select-all is not portable: on macOS Ctrl+A is the Emacs
 * move-to-line-start binding in text fields, so filling would PREPEND the new
 * text instead of replacing the old.
 */
const SELECT_FOCUSED_JS = `(function () {
	const el = document.activeElement;
	if (!el) return false;
	try { if (typeof el.select === "function") { el.select(); return true; } } catch { /* input types without selectable text */ }
	if (el.isContentEditable) {
		try { window.getSelection().selectAllChildren(el); return true; } catch { /* fall through */ }
	}
	return false;
})`;

/** JS-first scroll: works on background tabs, unlike CDP wheel events (Chromium drops those for hidden pages). */
const SCROLL_JS = `(function (dx, dy, x, y) {
	let el = document.scrollingElement || document.documentElement;
	if (x !== null && y !== null) {
		const hit = document.elementFromPoint(x, y);
		let cur = hit;
		while (cur && cur !== document.documentElement) {
			const style = getComputedStyle(cur);
			if (cur.scrollHeight > cur.clientHeight + 4 && /(auto|scroll)/.test(style.overflowY)) { el = cur; break; }
			cur = cur.parentElement;
		}
	}
	el.scrollBy({ top: dy, left: dx, behavior: "instant" });
	return {
		scrollY: Math.round(window.scrollY),
		scrolled: el === (document.scrollingElement || document.documentElement) ? "window" : el.tagName.toLowerCase(),
	};
})`;

// ---------------------------------------------------------------------------
// Key table for press_key (printable single chars go through Input.insertText)
// ---------------------------------------------------------------------------

const NAMED_KEYS: Record<string, { windowsVirtualKeyCode: number; key: string; code: string; text?: string }> = {
	enter: { windowsVirtualKeyCode: 13, key: "Enter", code: "Enter", text: "\r" },
	tab: { windowsVirtualKeyCode: 9, key: "Tab", code: "Tab" },
	escape: { windowsVirtualKeyCode: 27, key: "Escape", code: "Escape" },
	backspace: { windowsVirtualKeyCode: 8, key: "Backspace", code: "Backspace" },
	delete: { windowsVirtualKeyCode: 46, key: "Delete", code: "Delete" },
	arrowleft: { windowsVirtualKeyCode: 37, key: "ArrowLeft", code: "ArrowLeft" },
	arrowup: { windowsVirtualKeyCode: 38, key: "ArrowUp", code: "ArrowUp" },
	arrowright: { windowsVirtualKeyCode: 39, key: "ArrowRight", code: "ArrowRight" },
	arrowdown: { windowsVirtualKeyCode: 40, key: "ArrowDown", code: "ArrowDown" },
	home: { windowsVirtualKeyCode: 36, key: "Home", code: "Home" },
	end: { windowsVirtualKeyCode: 35, key: "End", code: "End" },
	pageup: { windowsVirtualKeyCode: 33, key: "PageUp", code: "PageUp" },
	pagedown: { windowsVirtualKeyCode: 34, key: "PageDown", code: "PageDown" },
	space: { windowsVirtualKeyCode: 32, key: " ", code: "Space", text: " " },
};

const MODIFIER_BITS: Record<string, number> = { alt: 1, ctrl: 2, meta: 4, cmd: 4, shift: 8 };

function parseModifiers(value: unknown): number {
	if (value === undefined) {
		return 0;
	}
	if (!Array.isArray(value)) {
		throw new Error("modifiers must be an array of strings (alt, ctrl, shift, cmd)");
	}
	let bits = 0;
	for (const entry of value) {
		const bit = MODIFIER_BITS[String(entry).toLowerCase()];
		if (!bit) {
			throw new Error(`unknown modifier: ${String(entry)}`);
		}
		bits |= bit;
	}
	return bits;
}

// ---------------------------------------------------------------------------
// DOM snapshot cache (per agent) for click_index / fill_index
// ---------------------------------------------------------------------------

interface DomElement {
	i: number;
	tag: string;
	role?: string;
	type?: string;
	cx: number;
	cy: number;
	text: string;
	kind: string;
	inView?: boolean;
}

interface DomSnapshot {
	targetId: string;
	/** Number of marked elements in the last dom() run — indexes valid are 0..count-1. */
	count: number;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function createBrowserHostHandlers(deps: BrowserHostHandlerDeps): HostRequestHandlers {
	const { manager, agentId, rlmDepth } = deps;
	const domSnapshots = new Map<string, DomSnapshot>();
	const targetOf = (payload: Record<string, unknown>) => optionalString(payload, "target_id");
	/** Which browser this agent is connected to, for self-describing responses. */
	const browserField = () => {
		const label = manager.connectionLabelFor(agentId);
		return label ? { browser: label } : {};
	};

	/**
	 * All action paths go through here. Without a targetId the first action
	 * auto-creates a tab when the agent has none, so agents never see
	 * NOT_CONNECTED for forgetting ensure_session — it just works. With an
	 * explicit targetId the tab must exist instead: main-agent operations on
	 * an unowned user tab ADOPT it on the fly (no separate attach_tab
	 * round-trip, no junk auto-created tab).
	 */
	async function run<T>(
		method: string,
		params?: Record<string, unknown>,
		targetId?: string,
		autoCreateTab = true,
	): Promise<T> {
		if (targetId === undefined) {
			// autoCreateTab=false (pure observers like page_info): no tab means a
			// clean NOT_CONNECTED from runForAgent, not a junk auto-created tab.
			if (autoCreateTab) {
				await manager.ensureSession(agentId);
			}
		} else {
			await manager.ensureOperable(agentId, targetId, rlmDepth);
		}
		return manager.runForAgent<T>(agentId, method, params, targetId);
	}

	async function clickAt(x: number, y: number, button: string, clicks: number, targetId?: string): Promise<void> {
		for (let n = 1; n <= clicks; n++) {
			await run("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: n }, targetId);
			await run("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: n }, targetId);
		}
	}

	/**
	 * Replace the focused element's contents with `text`. The element must
	 * already be focused (click first). Selection-based clearing works on every
	 * platform; the keyboard shortcut is only a fallback for inputs whose text
	 * is not selectable (type=number and friends).
	 */
	async function clearAndType(text: string, targetId?: string): Promise<void> {
		const selected = await evaluate<boolean>(SELECT_FOCUSED_JS, targetId).catch(() => false);
		if (!selected) {
			// Cmd on macOS (Ctrl+A is Emacs move-to-line-start there), Ctrl elsewhere.
			const modifiers = process.platform === "darwin" ? 4 : 2;
			await run(
				"Input.dispatchKeyEvent",
				{ type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers },
				targetId,
			);
			await run(
				"Input.dispatchKeyEvent",
				{ type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers },
				targetId,
			);
		}
		await run("Input.insertText", { text }, targetId);
	}

	async function evaluate<T>(expression: string, targetId?: string, autoCreateTab = true): Promise<T> {
		// Goes through run() so js()/dom()/scroll() auto-create a tab on first
		// use and explicit target_ids auto-adopt, same as the action handlers.
		// Pure observers (page_info) pass autoCreateTab=false: silently creating
		// a new-tab page and reporting it as "the current page" is worse than a
		// clean NOT_CONNECTED.
		const attempt = (code: string) =>
			run<{
				result?: { value?: T; description?: string };
				exceptionDetails?: { exception?: { description?: string }; text?: string };
			}>("Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true }, targetId, autoCreateTab);
		let response = await attempt(expression);
		// Top-level `return` is only legal inside a function. Retry wrapped in an
		// async IIFE ONLY on that exact syntax error — grepping the source for
		// the word "return" would misfire on expressions merely containing it
		// (e.g. a string literal), silently discarding their completion value.
		if (response.exceptionDetails) {
			const text = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "";
			if (/illegal return statement/i.test(text)) {
				response = await attempt(`(async () => { ${expression} })()`);
			}
		}
		if (response.exceptionDetails) {
			const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "unknown";
			throw new Error(`JS evaluation failed: ${detail}`);
		}
		return response.result?.value as T;
	}

	const handlers: HostRequestHandlers = {
		"browser.ensure_session": async () => {
			try {
				const target = await manager.ensureSession(agentId);
				return { target_id: target.targetId, ...browserField() };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.new_tab": async (payload) => {
			try {
				const url = optionalString(payload, "url") ?? "chrome://newtab/";
				const target = await manager.createTab(agentId, url);
				return { target_id: target.targetId, url, ...browserField() };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.attach_tab": async (payload) => {
			try {
				const targetId = requireString(payload, "target_id");
				const target = await manager.attachTab(agentId, targetId, rlmDepth);
				return { target_id: target.targetId, ...browserField() };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.close_tab": async (payload) => {
			try {
				let targetId = targetOf(payload);
				if (!targetId) {
					const mine = await manager.listTabs(agentId, "mine", rlmDepth);
					targetId = mine.tabs.find((t) => t.focused)?.targetId ?? mine.tabs[0]?.targetId;
					if (!targetId) {
						throw new BrowserError("TARGET_NOT_FOUND", "no tab to close");
					}
				}
				await manager.closeOwnedTab(agentId, targetId);
				return { closed: targetId };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.focus_tab": async (payload) => {
			try {
				// Logical focus only — never activates the tab in the browser UI.
				const targetId = requireString(payload, "target_id");
				manager.focusTab(agentId, targetId);
				return { focused: targetId };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.list_tabs": async (payload) => {
			try {
				const scope = optionalString(payload, "scope") === "all" ? "all" : "mine";
				// Active detection defaults ON for scope="all" — an agent listing
				// the user's tabs almost always wants the marker. Chrome 150+ needs
				// no attaches at all; older Chrome attaches one cached probe
				// session per user tab (the first may show a one-time consent
				// dialog; the attach mutex keeps dialogs serialized). Pass
				// include_active=false for a cheap, probe-free listing.
				const detectActive =
					payload.include_active === undefined ? scope === "all" : payload.include_active === true;
				const { tabs, detection, browser } = await manager.listTabs(agentId, scope, rlmDepth, detectActive);
				return {
					browser,
					tabs: tabs.map((t) => ({
						target_id: t.targetId,
						url: t.url,
						title: t.title,
						owner: t.owner,
						created_by_agent: t.createdByAgent,
						...(t.focused ? { focused: true } : {}),
						...(t.active ? { active: true } : {}),
					})),
					// Make probe failures visible to the agent: "no active tab" must
					// be distinguishable from "couldn't probe (consent dialog
					// unanswered)" — otherwise the agent can only shrug.
					...(detection && detection.failed > 0
						? {
								active_detection_note: `${detection.failed} tab(s) could not be probed (${detection.probed} succeeded) — the browser's "Allow remote debugging" dialog is likely waiting for a click; ask the user to allow it, then retry`,
							}
						: detection && detection.visible === 0 && detection.probed > 0 && !detection.authoritative
							? {
									active_detection_note: `all ${detection.probed} probed tab(s) report hidden — the browser window may be minimized/occluded, or its visibility state is stale; if the user IS looking at a tab, ask them to click the page once, then retry`,
								}
							: {}),
				};
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.goto_url": async (payload) => {
			try {
				const url = requireString(payload, "url");
				const targetId = targetOf(payload);
				// Snapshot the pre-navigation URL so the readiness poll below can
				// tell "old document still complete" from "new document arrived".
				const beforeUrl = await evaluate<string>("location.href", targetId).catch(() => undefined);
				await run("Page.navigate", { url }, targetId);
				// Wait out the navigation: right after Page.navigate returns, the
				// OLD document is still there and still reports readyState
				// "complete" — breaking on that would let a screenshot catch the
				// pre-navigation page. Only accept readyState once the navigation
				// has actually started (loading state or URL change). While the
				// document is being replaced, Runtime.evaluate can hit a
				// half-destroyed context (document.documentElement === null) —
				// polls tolerate that and retry until the budget runs out.
				const deadline = Date.now() + 10_000;
				let sawNavigationStart = false;
				while (Date.now() < deadline) {
					try {
						const probe = await evaluate<{ u: string; r: string }>(
							"({u: location.href, r: document.readyState})",
							targetId,
						);
						if (probe.r === "loading" || (beforeUrl !== undefined && probe.u !== beforeUrl)) {
							sawNavigationStart = true;
						}
						if (sawNavigationStart && (probe.r === "complete" || probe.r === "interactive")) {
							break;
						}
					} catch {
						// mid-navigation context churn — retry
					}
					await new Promise((resolve) => setTimeout(resolve, 250));
				}
				return { url };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.click_at_xy": async (payload) => {
			try {
				const x = requireNumber(payload, "x");
				const y = requireNumber(payload, "y");
				const button = optionalString(payload, "button") ?? "left";
				const clicks = Math.min(Math.max(1, Math.round(optionalNumber(payload, "clicks", 1))), 3);
				await clickAt(x, y, button, clicks, targetOf(payload));
				return { x, y };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.type_text": async (payload) => {
			try {
				const text = requireString(payload, "text");
				await run("Input.insertText", { text }, targetOf(payload));
				return { length: text.length };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.press_key": async (payload) => {
			try {
				const key = requireString(payload, "key");
				const modifiers = parseModifiers(payload.modifiers);
				const targetId = targetOf(payload);
				if (key.length === 1 && modifiers === 0) {
					// Plain printable char: trusted text insertion handles layout/shift correctly.
					await run("Input.insertText", { text: key }, targetId);
					return { key };
				}
				if (key.length === 1) {
					// Shortcut combos (Ctrl+A, Ctrl+C, …): insertText would silently
					// drop the modifiers, so dispatch real key events. Letters/digits
					// get exact codes; punctuation falls back to the char code, which
					// is close enough for the combos pages actually bind.
					const upper = key.toUpperCase();
					const isLetter = upper >= "A" && upper <= "Z";
					const isDigit = key >= "0" && key <= "9";
					const shiftOnly = modifiers === 8;
					const effectiveKey = isLetter && shiftOnly ? upper : key;
					const code = isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : "";
					const windowsVirtualKeyCode = isLetter || isDigit ? upper.charCodeAt(0) : key.charCodeAt(0);
					await run(
						"Input.dispatchKeyEvent",
						{ type: "rawKeyDown", key: effectiveKey, code, windowsVirtualKeyCode, modifiers },
						targetId,
					);
					// Ctrl/Alt/Cmd combos are commands, not typing — no char event.
					// Shift-only still types (Shift+a → "A").
					if ((modifiers & 7) === 0) {
						await run(
							"Input.dispatchKeyEvent",
							{ type: "char", text: effectiveKey, key: effectiveKey, code, modifiers },
							targetId,
						);
					}
					await run(
						"Input.dispatchKeyEvent",
						{ type: "keyUp", key: effectiveKey, code, windowsVirtualKeyCode, modifiers },
						targetId,
					);
					return { key: effectiveKey };
				}
				const named = NAMED_KEYS[key.toLowerCase()];
				if (!named) {
					throw new Error(
						`unknown key "${key}"; known: ${Object.keys(NAMED_KEYS).join(", ")}, or any single character`,
					);
				}
				await run(
					"Input.dispatchKeyEvent",
					{
						type: "rawKeyDown",
						key: named.key,
						code: named.code,
						windowsVirtualKeyCode: named.windowsVirtualKeyCode,
						modifiers,
					},
					targetId,
				);
				if (named.text) {
					await run(
						"Input.dispatchKeyEvent",
						{ type: "char", text: named.text, key: named.key, code: named.code, modifiers },
						targetId,
					);
				}
				await run(
					"Input.dispatchKeyEvent",
					{
						type: "keyUp",
						key: named.key,
						code: named.code,
						windowsVirtualKeyCode: named.windowsVirtualKeyCode,
						modifiers,
					},
					targetId,
				);
				return { key: named.key };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.scroll": async (payload) => {
			try {
				// JS scrollBy, not CDP wheel events: Chromium drops synthetic wheel
				// events on hidden/background tabs (suspended compositor), which
				// made scroll hang or silently no-op. JS scrolling works anywhere
				// and still fires the scroll events lazy-loading pages listen to.
				const targetId = targetOf(payload);
				const dy = optionalNumber(payload, "dy", 600);
				const dx = optionalNumber(payload, "dx", 0);
				let x: number | null = null;
				let y: number | null = null;
				if (payload.x !== undefined || payload.y !== undefined) {
					x = requireNumber(payload, "x");
					y = requireNumber(payload, "y");
				}
				const result = await evaluate<{ scrollY: number; scrolled: string }>(
					`${SCROLL_JS}(${dx}, ${dy}, ${x === null ? "null" : x}, ${y === null ? "null" : y})`,
					targetId,
				);
				return { dy, dx, scroll_y: result.scrollY, scrolled: result.scrolled };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.fill_input": async (payload) => {
			try {
				const selector = requireString(payload, "selector");
				const text = requireString(payload, "text");
				const targetId = targetOf(payload);
				// Trusted-input path: locate → click to focus → select all → insertText.
				// Trusted events drive React/Vue controlled inputs correctly.
				const rect = await evaluate<{ cx: number; cy: number } | null>(
					`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoViewIfNeeded(); const r = el.getBoundingClientRect(); return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }; })()`,
					targetId,
				);
				if (!rect) {
					throw new Error(`no element matches selector: ${selector}`);
				}
				await clickAt(rect.cx, rect.cy, "left", 1, targetId);
				await clearAndType(text, targetId);
				return { selector, length: text.length };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.js": async (payload) => {
			try {
				const expression = requireString(payload, "expression");
				const value = await evaluate<unknown>(expression, targetOf(payload));
				return { result: value === undefined ? null : (value as Record<string, unknown>) };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.page_info": async (payload) => {
			try {
				// autoCreateTab=false: page_info is an observer. Auto-creating a
				// chrome://newtab and reporting it as "the current page" misleads
				// agents answering "what page is the user on" — NOT_CONNECTED
				// sends them down the list_tabs/attach_tab path instead.
				const info = await evaluate<Record<string, unknown>>(
					"({url: location.href, title: document.title, w: innerWidth, h: innerHeight, sx: scrollX, sy: scrollY, pw: document.documentElement ? document.documentElement.scrollWidth : 0, ph: document.documentElement ? document.documentElement.scrollHeight : 0})",
					targetOf(payload),
					false,
				);
				return { ...info };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.screenshot": async (payload) => {
			try {
				if (!deps.modelSupportsVision()) {
					return {
						vision_unsupported: true,
						hint: "The current model cannot see images. Use dom() to list interactive elements with indexes, then click_index(i)/fill_index(i, text).",
					};
				}
				const quality = Math.min(Math.max(10, Math.round(optionalNumber(payload, "quality", 70))), 95);
				const targetId = targetOf(payload);
				// run() (not runForAgent directly): screenshot is the recommended
				// FIRST action (screenshot-first), so it must auto-create a tab
				// instead of failing NOT_CONNECTED on a fresh session.
				const result = await run<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality }, targetId);
				// The model reads coordinates off the (possibly downscaled) attached
				// image but must click in CSS viewport pixels — hand it the viewport
				// size so the conversion is arithmetic, not guesswork.
				const viewport = await evaluate<{ w: number; h: number; dpr: number }>(
					"({w: innerWidth, h: innerHeight, dpr: devicePixelRatio})",
					targetId,
				).catch(() => undefined);
				return {
					data: result.data,
					mime_type: "image/jpeg",
					...(viewport ? { viewport_css: viewport as unknown as Record<string, unknown> } : {}),
				};
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.dom": async (payload) => {
			try {
				const maxElements = Math.min(Math.max(10, Math.round(optionalNumber(payload, "max_elements", 100))), 500);
				const targetId = targetOf(payload);
				const snapshot = await evaluate<{
					url: string;
					title: string;
					viewport: { w: number; h: number; scrollY: number; pageHeight: number };
					elements: DomElement[];
					texts: Array<{ tag: string; text: string; cx: number; cy: number; inView: boolean }>;
					scrollables: Array<{ tag: string; text: string; cx: number; cy: number }>;
					totalInteractive: number;
					truncated: boolean;
				}>(`${DOM_SNAPSHOT_JS}(${maxElements})`, targetId);
				// Resolve which target this snapshot belongs to for later index clicks.
				const mine = await manager.listTabs(agentId, "mine", rlmDepth);
				const resolvedTarget = targetId ?? mine.tabs.find((t) => t.focused)?.targetId ?? mine.tabs[0]?.targetId;
				if (resolvedTarget) {
					domSnapshots.set(agentId, { targetId: resolvedTarget, count: snapshot.elements.length });
				}
				const lines = snapshot.elements.map((el) => {
					const desc = el.text ? ` "${el.text}"` : "";
					const role = el.role ? ` role=${el.role}` : "";
					const type = el.type ? ` type=${el.type}` : "";
					const offscreen = el.inView === false ? " [below-fold]" : "";
					return `[${el.i}] <${el.tag}${role}${type}>${desc} @(${el.cx},${el.cy})${offscreen}`;
				});
				const textLines = snapshot.texts.map((t) => {
					const offscreen = t.inView === false ? " [below-fold]" : "";
					return `<${t.tag}> "${t.text}" @(${t.cx},${t.cy})${offscreen}`;
				});
				return {
					url: snapshot.url,
					title: snapshot.title,
					viewport: snapshot.viewport as unknown as Record<string, unknown>,
					element_count: snapshot.elements.length,
					total_interactive: snapshot.totalInteractive,
					truncated: snapshot.truncated,
					elements_text: lines.join("\n"),
					text_node_count: snapshot.texts.length,
					text_content: textLines.join("\n"),
					scrollables: snapshot.scrollables as unknown as Record<string, unknown>[],
				};
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.click_index": async (payload) => {
			try {
				const index = Math.round(requireNumber(payload, "index"));
				const snapshot = lookupSnapshot(domSnapshots, agentId, index);
				// Re-locate via the data-pa-el marker: scroll into view, fresh coords.
				const located = await evaluate<{ cx: number; cy: number; tag: string } | null>(
					`${LOCATE_MARKED_JS}("data-pa-el", ${index})`,
					snapshot.targetId,
				);
				if (!located) {
					throw new Error(`[STALE_INDEX] element ${index} is gone — the page changed; re-run dom()`);
				}
				await clickAt(located.cx, located.cy, "left", 1, snapshot.targetId);
				return { index, x: located.cx, y: located.cy };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.fill_index": async (payload) => {
			try {
				const index = Math.round(requireNumber(payload, "index"));
				const text = requireString(payload, "text");
				const snapshot = lookupSnapshot(domSnapshots, agentId, index);
				const located = await evaluate<{ cx: number; cy: number; tag: string } | null>(
					`${LOCATE_MARKED_JS}("data-pa-el", ${index})`,
					snapshot.targetId,
				);
				if (!located) {
					throw new Error(`[STALE_INDEX] element ${index} is gone — the page changed; re-run dom()`);
				}
				await clickAt(located.cx, located.cy, "left", 1, snapshot.targetId);
				await clearAndType(text, snapshot.targetId);
				return { index, length: text.length };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.reconnect": async () => {
			try {
				// User asked to switch browsers: rebind THIS agent only — close its
				// created tabs on the old connection and release it, while other
				// agents keep their browsers untouched. The next ensure re-runs
				// the connection flow (re-prompting after the preference clears).
				await manager.resetAgent(agentId);
				deps.resetConnectionPreference?.();
				const target = await manager.ensureSession(agentId);
				return { target_id: target.targetId, reconnected: true };
			} catch (err) {
				rethrow(err);
			}
		},

		"browser.drain_events": async () => {
			const events = manager.drainEvents(agentId);
			return {
				events: events.map((event) => ({
					method: event.method,
					params: truncateParams(event.params),
				})) as unknown as Record<string, unknown>[],
			};
		},

		"browser.cdp": async (payload) => {
			try {
				const method = requireString(payload, "method");
				const params = payload.params;
				if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
					throw new Error("params must be an object");
				}
				const result = await run(method, params as Record<string, unknown> | undefined, targetOf(payload));
				return { result: result as Record<string, unknown> };
			} catch (err) {
				rethrow(err);
			}
		},
	};
	return handlers;
}

function lookupSnapshot(snapshots: Map<string, DomSnapshot>, agentId: string, index: number): DomSnapshot {
	const snapshot = snapshots.get(agentId);
	if (!snapshot) {
		throw new Error("[STALE_INDEX] no dom() snapshot yet — call dom() first to list elements");
	}
	if (index < 0 || index >= snapshot.count) {
		throw new Error(
			`[STALE_INDEX] index ${index} not in the last dom() snapshot (${snapshot.count} elements) — re-run dom() if the page changed`,
		);
	}
	return snapshot;
}

/** Keep drained events small: big Network payloads are useless to the model. */
function truncateParams(params: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!params) {
		return params;
	}
	const serialized = JSON.stringify(params);
	if (serialized.length <= 600) {
		return params;
	}
	return { truncated: serialized.slice(0, 600) };
}
