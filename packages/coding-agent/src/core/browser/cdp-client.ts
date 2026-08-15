/**
 * Minimal raw CDP (Chrome DevTools Protocol) client over a single WebSocket.
 *
 * First-principles design: CDP is JSON-RPC on one websocket. This client does
 * id-paired request/response, session-scoped flat messaging (flatten: true),
 * and method-keyed event dispatch. Nothing else — no domain wrappers, no
 * retry framework, no supervision. The BrowserManager layers ownership and
 * locking on top; this layer stays dumb and faithful to the wire protocol.
 *
 * Uses Node 22's built-in WebSocket — zero dependencies.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CdpEvent {
	method: string;
	params?: Record<string, unknown>;
	sessionId?: string;
}

export class CdpError extends Error {
	constructor(
		message: string,
		readonly method?: string,
		readonly code?: number,
	) {
		super(message);
		this.name = "CdpError";
	}
}

interface PendingCall {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	method: string;
}

type EventListener = (event: CdpEvent) => void;

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

export class CdpClient {
	private _ws: WebSocket | undefined;
	private _nextId = 1;
	private _pending = new Map<number, PendingCall>();
	private _listeners = new Map<string, Set<EventListener>>();
	private _anyListeners = new Set<EventListener>();
	private _closeListeners = new Set<() => void>();
	private _closed = false;
	private _closeNotified = false;

	private constructor() {}

	/** Connect to a browser-level CDP websocket URL. */
	static async connect(wsUrl: string): Promise<CdpClient> {
		const client = new CdpClient();
		const ws = new WebSocket(wsUrl);
		client._ws = ws;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new CdpError(`CDP connect timed out: ${wsUrl}`)), CONNECT_TIMEOUT_MS);
			ws.onopen = () => {
				clearTimeout(timer);
				resolve();
			};
			ws.onerror = () => {
				clearTimeout(timer);
				reject(new CdpError(`CDP connect failed: ${wsUrl}`));
			};
		});
		ws.onmessage = (msg) => client._onMessage(msg);
		ws.onclose = () => client._onClose();
		ws.onerror = () => client._onClose();
		return client;
	}

	get closed(): boolean {
		return this._closed;
	}

	/**
	 * Send a raw CDP command. `sessionId` targets a specific page session
	 * (from Target.attachToTarget with flatten: true); omit it for
	 * browser-level commands (Target.*, Browser.*).
	 */
	sendRaw<T = Record<string, unknown>>(
		method: string,
		params?: Record<string, unknown>,
		sessionId?: string,
	): Promise<T> {
		if (this._closed || !this._ws) {
			return Promise.reject(new CdpError("CDP connection is closed", method));
		}
		const id = this._nextId++;
		const message: Record<string, unknown> = { id, method };
		if (params !== undefined) {
			message.params = params;
		}
		if (sessionId !== undefined) {
			message.sessionId = sessionId;
		}
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this._pending.delete(id);
				reject(new CdpError(`CDP call timed out: ${method}`, method));
			}, CALL_TIMEOUT_MS);
			this._pending.set(id, {
				method,
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this._ws!.send(JSON.stringify(message));
		});
	}

	/** Subscribe to a CDP event method (e.g. "Target.targetDestroyed"). Returns an unsubscribe function. */
	on(method: string, listener: EventListener): () => void {
		let set = this._listeners.get(method);
		if (!set) {
			set = new Set();
			this._listeners.set(method, set);
		}
		set.add(listener);
		return () => set.delete(listener);
	}

	/** Subscribe to ALL CDP events (wildcard). Returns an unsubscribe function. */
	onAny(listener: EventListener): () => void {
		this._anyListeners.add(listener);
		return () => this._anyListeners.delete(listener);
	}

	/** Called once when the underlying websocket closes (browser exit, network drop). */
	onClose(listener: () => void): () => void {
		this._closeListeners.add(listener);
		return () => this._closeListeners.delete(listener);
	}

	close(): void {
		if (this._closed) {
			return;
		}
		this._closed = true;
		try {
			this._ws?.close();
		} catch {
			// already gone
		}
		this._onClose();
	}

	private _onMessage(msg: WebSocketMessageEvent): void {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(String(msg.data));
		} catch {
			return;
		}
		if (typeof data.id === "number") {
			const pending = this._pending.get(data.id);
			if (!pending) {
				return;
			}
			this._pending.delete(data.id);
			const error = data.error as { message?: string; code?: number } | undefined;
			if (error) {
				pending.reject(new CdpError(error.message ?? `CDP error in ${pending.method}`, pending.method, error.code));
			} else {
				pending.resolve((data.result as Record<string, unknown>) ?? {});
			}
			return;
		}
		// Event message.
		const method = data.method as string | undefined;
		if (!method) {
			return;
		}
		const event: CdpEvent = {
			method,
			params: data.params as Record<string, unknown> | undefined,
			sessionId: data.sessionId as string | undefined,
		};
		const set = this._listeners.get(method);
		if (set) {
			for (const listener of [...set]) {
				try {
					listener(event);
				} catch {
					// listener bugs must not break the dispatch loop
				}
			}
		}
		for (const listener of [...this._anyListeners]) {
			try {
				listener(event);
			} catch {
				// listener bugs must not break the dispatch loop
			}
		}
	}

	private _onClose(): void {
		if (this._closeNotified) {
			return;
		}
		this._closeNotified = true;
		this._closed = true;
		const error = new CdpError("CDP connection closed");
		for (const pending of this._pending.values()) {
			pending.reject(error);
		}
		this._pending.clear();
		for (const listener of this._closeListeners) {
			try {
				listener();
			} catch {
				// ignore
			}
		}
	}
}

// The DOM lib type for the message event differs across TS configs; keep it local.
interface WebSocketMessageEvent {
	data: unknown;
}

// ---------------------------------------------------------------------------
// Browser discovery: find the websocket URL of an already-running browser.
// Mirrors browser-harness daemon.py get_ws_url() — env override, profile-dir
// DevToolsActivePort scan, then well-known port probes.
// ---------------------------------------------------------------------------

/** User-data dirs of mainstream Chromium forks, per platform, with display labels. */
function candidateProfileDirs(): Array<{ label: string; dir: string }> {
	const home = homedir();
	switch (process.platform) {
		case "darwin":
			return [
				{ label: "Google Chrome", dir: "Library/Application Support/Google/Chrome" },
				{ label: "Microsoft Edge", dir: "Library/Application Support/Microsoft Edge" },
				{ label: "Brave", dir: "Library/Application Support/BraveSoftware/Brave-Browser" },
				{ label: "Chromium", dir: "Library/Application Support/Chromium" },
			].map((e) => ({ label: e.label, dir: join(home, e.dir) }));
		case "win32":
			return [
				{ label: "Google Chrome", dir: "AppData/Local/Google/Chrome/User Data" },
				{ label: "Chromium", dir: "AppData/Local/Chromium/User Data" },
				{ label: "Microsoft Edge", dir: "AppData/Local/Microsoft/Edge/User Data" },
				{ label: "Brave", dir: "AppData/Local/BraveSoftware/Brave-Browser/User Data" },
			].map((e) => ({ label: e.label, dir: join(home, e.dir) }));
		default:
			return [
				{ label: "Google Chrome", dir: ".config/google-chrome" },
				{ label: "Chromium", dir: ".config/chromium" },
				{ label: "Chromium", dir: ".config/chromium-browser" },
				{ label: "Microsoft Edge", dir: ".config/microsoft-edge" },
				{ label: "Brave", dir: ".config/BraveSoftware/Brave-Browser" },
			].map((e) => ({ label: e.label, dir: join(home, e.dir) }));
	}
}

/** Three-way probe of a DevTools HTTP endpoint — "dead" and "404 but alive" must not be confused. */
async function probeHttpEndpoint(
	base: string,
	timeoutMs: number,
): Promise<{ status: "ok"; wsUrl: string } | { status: "http-disabled" } | { status: "dead" }> {
	try {
		const response = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
		if (response.ok) {
			const version = (await response.json()) as Record<string, unknown>;
			const wsUrl = version?.webSocketDebuggerUrl;
			if (typeof wsUrl === "string" && wsUrl) {
				return { status: "ok", wsUrl };
			}
			return { status: "dead" };
		}
		// Chrome 147+ disables /json/* on the default profile: the browser IS
		// alive (it answered HTTP), the ws path from DevToolsActivePort works.
		if (response.status === 404) {
			return { status: "http-disabled" };
		}
		return { status: "dead" };
	} catch {
		// Connection refused / timeout: nothing listens on the port.
		return { status: "dead" };
	}
}

/** Resolve an HTTP DevTools endpoint (http://host:port) to its browser websocket URL. */
export async function resolveHttpEndpointToWs(httpUrl: string, timeoutMs = 5_000): Promise<string | undefined> {
	const base = httpUrl.replace(/\/+$/, "");
	const probe = await probeHttpEndpoint(base, timeoutMs);
	return probe.status === "ok" ? probe.wsUrl : undefined;
}

export interface AttachCandidate {
	/** Display label, e.g. "Google Chrome" or "port 9222". */
	label: string;
	wsUrl: string;
}

/**
 * Discover ALL running debuggable browsers, each labeled by the profile dir
 * its DevToolsActivePort lives in (Chrome vs Edge vs Brave…) or the probed
 * port. Only live, connectable endpoints are returned.
 */
export async function discoverAttachCandidates(): Promise<AttachCandidate[]> {
	const candidates: AttachCandidate[] = [];

	const envUrl = process.env.VSURF_BROWSER_CDP_URL;
	if (envUrl) {
		const wsUrl = envUrl.startsWith("ws") ? envUrl : await resolveHttpEndpointToWs(envUrl);
		if (wsUrl) {
			candidates.push({ label: `env (${envUrl})`, wsUrl });
		}
	}

	for (const { label, dir } of candidateProfileDirs()) {
		const activePortFile = join(dir, "DevToolsActivePort");
		if (!existsSync(activePortFile)) {
			continue;
		}
		let port: string;
		let wsPath: string | undefined;
		try {
			const lines = readFileSync(activePortFile, "utf-8").split(/\r?\n/);
			port = (lines[0] ?? "").trim();
			wsPath = (lines[1] ?? "").trim() || undefined;
		} catch {
			continue;
		}
		if (!port || !/^\d+$/.test(port)) {
			continue;
		}
		// Liveness is judged by HTTP. A leftover DevToolsActivePort from a dead
		// browser must NOT produce a candidate — only a live endpoint (200 with
		// a ws URL) or Chrome 147+'s /json/* lockdown (404, use the file's ws
		// path) count as alive.
		const probe = await probeHttpEndpoint(`http://127.0.0.1:${port}`, 1_500);
		let wsUrl: string | undefined;
		if (probe.status === "ok") {
			wsUrl = probe.wsUrl;
		} else if (probe.status === "http-disabled" && wsPath) {
			wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
		}
		if (wsUrl) {
			candidates.push({ label, wsUrl });
		}
	}

	for (const probePort of [9222, 9223]) {
		const wsUrl = await resolveHttpEndpointToWs(`http://127.0.0.1:${probePort}`, 1_000);
		if (wsUrl && !candidates.some((c) => c.wsUrl === wsUrl)) {
			candidates.push({ label: `port ${probePort}`, wsUrl });
		}
	}
	return candidates;
}

/**
 * Discover a running browser's CDP websocket URL (first live candidate).
 * Kept for simple flows; prefer discoverAttachCandidates when the user may
 * have several browsers to choose between.
 */
export async function discoverRunningBrowserWsUrl(): Promise<string | undefined> {
	const candidates = await discoverAttachCandidates();
	return candidates[0]?.wsUrl;
}
