/**
 * BrowserManager: shared browsers, tab-level ownership for many agents.
 *
 * Design lineage and corrections:
 * - VibeSurf proved tab-level assignment works, but its ownership was derived
 *   (recomputed from session pools), checked only at assignment time, blind to
 *   externally closed tabs, and quota-free. Here ownership is a single
 *   authoritative Map, validated on EVERY operation, seats are taken before
 *   any await, and targetDestroyed releases automatically.
 * - Provenance matters: tabs an agent created are closed when it detaches;
 *   tabs it adopted from the user are only released — never closed.
 * - Depth policy: the main agent (rlm depth 0) may see and adopt the user's
 *   tabs; child agents only ever get fresh tabs and see nothing else.
 * - Logical focus (VibeSurf's agent_focus): each agent has a focus tab that
 *   targetless operations hit. Pure bookkeeping — Target.activateTarget is
 *   never called; everything runs on background tabs.
 *
 * MULTI-CONNECTION: agents are each bound to one browser connection (keyed by
 * websocket URL). Different agents may live on different browsers at the same
 * time (e.g. one on the user's Chrome, a child on a managed Chromium), and
 * reconnecting one agent never disturbs the others.
 */

import { type CdpClient, CdpError, type CdpEvent } from "./cdp-client.js";

export type BrowserErrorCode =
	| "NOT_CONNECTED"
	| "NOT_OWNER"
	| "TARGET_NOT_FOUND"
	| "TAB_DESTROYED"
	| "QUOTA_EXCEEDED"
	| "ADOPT_NOT_ALLOWED"
	| "CDP_ERROR";

export class BrowserError extends Error {
	constructor(
		readonly code: BrowserErrorCode,
		message: string,
	) {
		super(message);
		this.name = "BrowserError";
	}
}

export interface BrowserTabInfo {
	targetId: string;
	url: string;
	title: string;
	/** Owning agent, or null for the user's own unassigned tabs. */
	owner: string | null;
	createdByAgent: boolean;
	/** The agent's logical focus tab (scope "mine" only) — targetless operations hit this one. */
	focused?: boolean;
	/** Best-effort "the user is looking at this tab" marker (scope "all" only). */
	active?: boolean;
}

/**
 * Outcome of active-tab detection, so "no tab marked active" can be told
 * apart from "probing failed" (e.g. the browser's consent dialog went
 * unanswered and every attach timed out). Only set when detection ran.
 */
export interface ActiveDetectionInfo {
	/** Tabs whose visibility was actually evaluated. */
	probed: number;
	/** Tabs we tried but failed to probe (attach timed out / evaluate failed). */
	failed: number;
	/** Tabs that reported visible. */
	visible: number;
	/** True when the answer came from Chrome 150+'s tab-strip state (embedderData.tabActive) rather than visibility probing. */
	authoritative?: boolean;
}

export interface ListTabsResult {
	tabs: BrowserTabInfo[];
	detection?: ActiveDetectionInfo;
	/** Which browser these tabs live on (attach label / "managed browser" / endpoint). */
	browser?: string;
}

export interface AgentTarget {
	targetId: string;
	sessionId: string;
}

/** Injected by the wiring layer; encapsulates settings, UI prompting, discovery, and launching. */
export type ConnectionProvider = () => Promise<ProvidedConnection>;

export interface ProvidedConnection {
	client: CdpClient;
	/** Stable identity of this connection (the browser websocket URL). */
	key: string;
	/**
	 * Human-readable origin of the browser, surfaced to agents in list_tabs /
	 * ensure_session responses: "Google Chrome" (attach), "managed browser",
	 * the endpoint URL… Agents otherwise cannot tell whether they are driving
	 * the USER's browser or an isolated managed one — and guess wrong.
	 */
	label?: string;
}

const MAX_TABS_PER_AGENT = 5;
const MAX_TABS_GLOBAL = 20;
const EVENT_BUFFER_SIZE = 500;

/** URL schemes that are never real user pages. */
const INTERNAL_URL_PREFIXES = [
	"chrome://",
	"chrome-untrusted://",
	"devtools://",
	"chrome-extension://",
	"edge://",
	"brave://",
];

function isRealPageUrl(url: string): boolean {
	if (url === "about:blank") {
		return true;
	}
	return !INTERNAL_URL_PREFIXES.some((prefix) => url.startsWith(prefix));
}

interface AgentState {
	/** targetId → sessionId for every tab this agent owns. */
	targets: Map<string, string>;
	/** The agent's logical focus: which of its tabs targetless operations hit. */
	focusTargetId?: string;
	events: CdpEvent[];
}

interface ConnectionState {
	client: CdpClient;
	/** Agents currently bound to this connection. */
	agents: Set<string>;
	/** Which browser this connection is (see ProvidedConnection.label). */
	label?: string;
}

export class BrowserManager {
	/** connection key (browser ws URL) → live connection */
	private _connections = new Map<string, ConnectionState>();
	private _connecting = new Map<string, Promise<CdpClient>>();
	/** agentId → connection key */
	private _agentConnection = new Map<string, string>();
	/** Authoritative ownership: targetId → agentId. Written before any attach await. */
	private _owners = new Map<string, string>();
	/** Subset of owned targets the agent created (closed on detach; adopted tabs are only released). */
	private _created = new Set<string>();
	private _sessionToTarget = new Map<string, string>();
	private _agents = new Map<string, AgentState>();
	private _locks = new Map<string, Promise<unknown>>();
	/**
	 * Per-connection attach mutex. On Chrome 144+ every Target.attachToTarget
	 * from a not-yet-consented client pops a browser-MODAL "Allow remote
	 * debugging" dialog — several concurrent attaches stack modal dialogs and
	 * wedge the whole browser UI (a single attach works fine). One attach in
	 * flight at a time means one dialog at a time; once allowed, the consent
	 * sticks for the browser session and the queue drains silently.
	 */
	private _attachLocks = new WeakMap<CdpClient, Promise<unknown>>();
	/**
	 * Cached visibility-probe sessions for UNOWNED (user) tabs: attach once,
	 * reuse forever. Chrome 144+ can pop its remote-debugging consent dialog on
	 * EVERY fresh attach, so the previous attach→probe→detach-per-list_tabs
	 * pattern produced one dialog per user tab per call — cached sessions make
	 * repeat list_tabs(scope="all") calls attach-free.
	 */
	private _visibilitySessions = new Map<string, { client: CdpClient; sessionId: string }>();

	constructor(
		private readonly _connectionProvider: ConnectionProvider,
		private readonly _options: { maxTabsPerAgent?: number; maxTabsGlobal?: number } = {},
	) {}

	// ------------------------------------------------------------------
	// Connections (per-agent binding; several browsers may be live at once)
	// ------------------------------------------------------------------

	/** The connection key an agent is bound to, if any. */
	connectionKeyFor(agentId: string): string | undefined {
		return this._agentConnection.get(agentId);
	}

	/** Which browser the agent is connected to (see ProvidedConnection.label), if connected. */
	connectionLabelFor(agentId: string): string | undefined {
		const key = this._agentConnection.get(agentId);
		return key ? this._connections.get(key)?.label : undefined;
	}

	private _clientFor(agentId: string): CdpClient | undefined {
		const key = this._agentConnection.get(agentId);
		if (!key) {
			return undefined;
		}
		const conn = this._connections.get(key);
		return conn && !conn.client.closed ? conn.client : undefined;
	}

	private _ensureClient(agentId: string): Promise<CdpClient> {
		const existing = this._clientFor(agentId);
		if (existing) {
			return Promise.resolve(existing);
		}
		let pending = this._connecting.get(agentId);
		if (!pending) {
			pending = this._connectionProvider()
				.then(({ client, key, label }) => {
					// Another agent may already hold a connection to this browser —
					// share it rather than opening a duplicate socket. (The provider
					// may itself return the shared instance; never close that.)
					let conn = this._connections.get(key);
					if (conn && !conn.client.closed) {
						if (conn.client !== client) {
							client.close();
						}
					} else {
						conn = { client, agents: new Set(), label };
						this._connections.set(key, conn);
						this._wireClient(key, client);
					}
					conn.agents.add(agentId);
					this._agentConnection.set(agentId, key);
					return conn.client;
				})
				.finally(() => {
					this._connecting.delete(agentId);
				});
			this._connecting.set(agentId, pending);
		}
		return pending;
	}

	private _wireClient(key: string, client: CdpClient): void {
		// Without target discovery the browser never emits targetDestroyed, and
		// externally closed tabs would look owned forever.
		void client.sendRaw("Target.setDiscoverTargets", { discover: true }).catch(() => {});
		client.on("Target.targetDestroyed", (event) => {
			const targetId = event.params?.targetId as string | undefined;
			if (targetId) {
				this._releaseTarget(targetId, "destroyed");
			}
		});
		client.on("Inspector.targetCrashed", (event) => {
			const targetId = event.sessionId ? this._sessionToTarget.get(event.sessionId) : undefined;
			if (targetId) {
				this._bufferEventForTarget(targetId, {
					method: "Vsurf.targetCrashed",
					params: {},
					sessionId: event.sessionId,
				});
				// A crashed tab will never answer again — release it so listTabs
				// stops showing it and the next operation fails with the documented
				// TAB_DESTROYED instead of an opaque CDP_ERROR.
				this._releaseTarget(targetId, "crashed");
			}
		});
		client.onAny((event) => {
			// Buffer per-agent events (Network/Page/Runtime chatter) for drain_events.
			if (!event.sessionId) {
				return;
			}
			const targetId = this._sessionToTarget.get(event.sessionId);
			if (targetId) {
				this._bufferEventForTarget(targetId, event);
			}
		});
		client.onClose(() => {
			// Release everything living on this connection only — agents bound to
			// other browsers are untouched.
			const conn = this._connections.get(key);
			this._connections.delete(key);
			for (const [targetId, probe] of this._visibilitySessions) {
				if (probe.client === client) {
					this._visibilitySessions.delete(targetId);
				}
			}
			if (!conn) {
				return;
			}
			for (const agentId of conn.agents) {
				this._agentConnection.delete(agentId);
				const state = this._agents.get(agentId);
				if (state) {
					for (const targetId of [...state.targets.keys()]) {
						this._releaseTarget(targetId, "connection-closed");
					}
				}
			}
		});
	}

	// ------------------------------------------------------------------
	// Agent sessions
	// ------------------------------------------------------------------

	private _agentState(agentId: string): AgentState {
		let state = this._agents.get(agentId);
		if (!state) {
			state = { targets: new Map(), events: [] };
			this._agents.set(agentId, state);
		}
		return state;
	}

	/**
	 * Ensure the agent owns at least one tab, creating a fresh one if needed.
	 * Never hijacks the user's current tab — adoption is explicit via attachTab.
	 */
	async ensureSession(agentId: string): Promise<AgentTarget> {
		const state = this._agentState(agentId);
		const existing = state.focusTargetId ?? (state.targets.keys().next().value as string | undefined);
		if (existing) {
			return { targetId: existing, sessionId: state.targets.get(existing)! };
		}
		return this.createTab(agentId, "chrome://newtab/");
	}

	/** Open a fresh tab owned by the agent (in the background — never steals UI focus). */
	async createTab(agentId: string, url: string): Promise<AgentTarget> {
		const state = this._agentState(agentId);
		const maxTabs = this._options.maxTabsPerAgent ?? MAX_TABS_PER_AGENT;
		if (state.targets.size >= maxTabs) {
			throw new BrowserError(
				"QUOTA_EXCEEDED",
				`Agent already owns ${state.targets.size} tabs (max ${maxTabs}); reuse one or close it first`,
			);
		}
		// Global backstop: recursive child agents each get their own per-agent
		// quota, so only a process-wide cap stops a runaway fan-out.
		if (this._created.size >= (this._options.maxTabsGlobal ?? MAX_TABS_GLOBAL)) {
			throw new BrowserError("QUOTA_EXCEEDED", "Global agent tab limit reached");
		}
		const client = await this._ensureClient(agentId);
		const { targetId } = await client.sendRaw<{ targetId: string }>("Target.createTarget", { url, background: true });
		// Take the seat BEFORE the attach await — concurrent calls must see the owner.
		this._owners.set(targetId, agentId);
		this._created.add(targetId);
		try {
			return await this._attachOwned(agentId, targetId);
		} catch (error) {
			this._releaseTarget(targetId, "attach-failed");
			throw error;
		}
	}

	/**
	 * Adopt an existing (user-opened) tab for the main agent. Child agents
	 * (rlm depth > 0) may never adopt — isolation from the user's browsing.
	 */
	async attachTab(agentId: string, targetId: string, rlmDepth: number): Promise<AgentTarget> {
		if (rlmDepth > 0) {
			throw new BrowserError("ADOPT_NOT_ALLOWED", "Child agents cannot adopt existing tabs; use new_tab instead");
		}
		const owner = this._owners.get(targetId);
		if (owner && owner !== agentId) {
			throw new BrowserError("NOT_OWNER", `Tab ${targetId} belongs to another agent`);
		}
		const client = await this._ensureClient(agentId);
		const targets = await this._listRawTargets(client);
		const target = targets.find((t) => t.targetId === targetId);
		if (!target) {
			throw new BrowserError("TARGET_NOT_FOUND", `Tab ${targetId} does not exist`);
		}
		// Seat first, attach second. Adopted tabs are NOT in _created: detach only releases them.
		this._owners.set(targetId, agentId);
		try {
			return await this._attachOwned(agentId, targetId);
		} catch (error) {
			this._releaseTarget(targetId, "attach-failed");
			throw error;
		}
	}

	private async _attachOwned(agentId: string, targetId: string): Promise<AgentTarget> {
		const client = await this._ensureClient(agentId);
		// Serialized + consent-surfacing: concurrent attaches stack Chrome's
		// consent modals, and a stalled attach pulls its tab to the front so the
		// dialog becomes clickable.
		const sessionId = await this._attachTarget(client, targetId);
		this._sessionToTarget.set(sessionId, targetId);
		const state = this._agentState(agentId);
		state.targets.set(targetId, sessionId);
		// Newly attached/created tabs take the agent's logical focus (VibeSurf
		// semantics: new_tab then a targetless screenshot hits the NEW tab).
		state.focusTargetId = targetId;
		// Unblock JS execution on freshly attached targets (no-op when not paused).
		await client.sendRaw("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {});
		// Enable the domains our observation/event surface relies on. Failures are
		// tolerated per-domain — a page that can't enable Network still clicks fine.
		for (const domain of ["Page", "Runtime", "DOM", "Network"]) {
			try {
				await client.sendRaw(`${domain}.enable`, {}, sessionId);
			} catch {
				// best-effort
			}
		}
		return { targetId, sessionId };
	}

	/**
	 * Main-agent convenience (VibeSurf's main_browser_session semantics): an
	 * operation that explicitly targets an unowned user tab adopts it on the
	 * fly instead of failing "not assigned". No-op when the tab is already
	 * ours, belongs to another agent (runForAgent produces the error), or the
	 * caller is a child agent (depth > 0 may never adopt).
	 */
	async ensureOperable(agentId: string, targetId: string, rlmDepth: number): Promise<void> {
		const owner = this._owners.get(targetId);
		if (owner !== undefined || rlmDepth > 0) {
			return;
		}
		await this.attachTab(agentId, targetId, rlmDepth);
	}

	/** Move the agent's logical focus to another tab it owns. */
	focusTab(agentId: string, targetId: string): void {
		this._resolveOwnedTarget(agentId, targetId);
		this._agentState(agentId).focusTargetId = targetId;
	}

	// ------------------------------------------------------------------
	// Operation routing (ownership check + per-target mutex on every call)
	// ------------------------------------------------------------------

	/**
	 * Run a CDP command against a tab the agent owns, serialized per tab so
	 * interleaved calls from one agent can't corrupt a click/navigate sequence.
	 * Defaults to the agent's focused tab.
	 */
	async runForAgent<T>(
		agentId: string,
		method: string,
		params?: Record<string, unknown>,
		targetId?: string,
	): Promise<T> {
		const resolvedTarget = this._resolveOwnedTarget(agentId, targetId);
		return this._withTargetLock(resolvedTarget, async () => {
			// Re-check inside the lock: the tab may have died while we queued.
			const sessionId = this._agentState(agentId).targets.get(resolvedTarget);
			if (!sessionId) {
				throw new BrowserError(
					"TAB_DESTROYED",
					`Tab ${resolvedTarget} is gone (closed or crashed); open a new one`,
				);
			}
			const client = await this._ensureClient(agentId);
			try {
				return await client.sendRaw<T>(method, params, sessionId);
			} catch (error) {
				throw this._translateError(error, method);
			}
		});
	}

	private _resolveOwnedTarget(agentId: string, targetId?: string): string {
		const state = this._agentState(agentId);
		if (targetId === undefined) {
			const primary = state.focusTargetId ?? (state.targets.keys().next().value as string | undefined);
			if (!primary) {
				throw new BrowserError("NOT_CONNECTED", "Agent has no tab yet; call ensure_session first");
			}
			return primary;
		}
		if (this._owners.get(targetId) !== agentId || !state.targets.has(targetId)) {
			const owner = this._owners.get(targetId);
			if (owner && owner !== agentId) {
				throw new BrowserError("NOT_OWNER", `Tab ${targetId} belongs to another agent`);
			}
			throw new BrowserError("TARGET_NOT_FOUND", `Tab ${targetId} is not assigned to this agent`);
		}
		return targetId;
	}

	private async _withTargetLock<T>(targetId: string, fn: () => Promise<T>): Promise<T> {
		const previous = this._locks.get(targetId) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		// Store a single reference and compare against THAT — storing
		// next.catch(...) inline and comparing to `next` never matches, so the
		// entry was never cleaned up and the chain grew on every operation.
		const stored = next.catch(() => {});
		this._locks.set(targetId, stored);
		try {
			return await next;
		} finally {
			if (this._locks.get(targetId) === stored) {
				this._locks.delete(targetId);
			}
		}
	}

	/**
	 * Serialize Target.attachToTarget per connection (see _attachLocks). The
	 * queue sits BEFORE sendRaw, so a queued attach's 60s CDP call timeout only
	 * starts once it actually goes on the wire — a slow user click on the
	 * consent dialog doesn't eat the waiting attaches' budgets.
	 */
	private _withAttachLock<T>(client: CdpClient, fn: () => Promise<T>): Promise<T> {
		const previous = this._attachLocks.get(client) ?? Promise.resolve();
		const next = previous.then(fn, fn);
		this._attachLocks.set(
			client,
			next.catch(() => {}),
		);
		return next;
	}

	/**
	 * Attach to a target, serialized (see _attachLocks). A timeout almost
	 * certainly means Chrome's modal "Allow remote debugging" consent dialog
	 * is waiting for a click — translate it into an actionable error instead
	 * of an opaque CDP timeout. We deliberately do NOT force the tab to the
	 * front: agent tabs live in the background by design, and yanking the
	 * user's current tab around is worse than asking them to click a dialog.
	 */
	private _attachTarget(client: CdpClient, targetId: string): Promise<string> {
		return this._withAttachLock(client, async () => {
			try {
				const { sessionId } = await client.sendRaw<{ sessionId: string }>("Target.attachToTarget", {
					targetId,
					flatten: true,
				});
				return sessionId;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (/timed out/i.test(message)) {
					throw new CdpError(
						"attach timed out — the browser is probably waiting on its 'Allow remote debugging' consent dialog; click Allow in the browser, then retry",
						"Target.attachToTarget",
					);
				}
				throw error;
			}
		});
	}

	// ------------------------------------------------------------------
	// Listing (filtered BEFORE data leaves the manager)
	// ------------------------------------------------------------------

	/**
	 * List tabs visible to the agent. scope "mine" (default, forced for child
	 * agents) returns only owned tabs; scope "all" (main agent only) also
	 * lists the user's unassigned pages ON THE AGENT'S OWN CONNECTION, with a
	 * best-effort active marker when detectActive is set (Chrome 150+ answers
	 * from tab-strip state without any attaches; older Chrome attaches a
	 * cached probe session per user tab).
	 */
	async listTabs(
		agentId: string,
		scope: "mine" | "all",
		rlmDepth: number,
		detectActive = false,
	): Promise<ListTabsResult> {
		const effectiveScope = rlmDepth > 0 ? "mine" : scope;
		const state = this._agentState(agentId);
		const client = await this._ensureClient(agentId);
		if (effectiveScope === "mine") {
			// Include internal pages here: an agent's fresh tab is chrome://newtab,
			// and filtering it out of the lookup would list it with an empty
			// url/title even though the agent legitimately owns it.
			const rawTargets = await this._listRawTargets(client, true);
			const byId = new Map(rawTargets.map((t) => [t.targetId, t]));
			return {
				browser: this.connectionLabelFor(agentId),
				tabs: [...state.targets.keys()].map((targetId) => {
					const raw = byId.get(targetId);
					return {
						targetId,
						url: raw?.url ?? "",
						title: raw?.title ?? "",
						owner: agentId,
						createdByAgent: this._created.has(targetId),
						focused: state.focusTargetId === targetId,
					};
				}),
			};
		}
		const rawTargets = await this._listRawTargets(client);
		const detection = detectActive ? await this._detectActiveTargets(client, rawTargets) : undefined;
		return {
			browser: this.connectionLabelFor(agentId),
			tabs: rawTargets.map((raw) => {
				const owner = this._owners.get(raw.targetId) ?? null;
				return {
					targetId: raw.targetId,
					url: raw.url,
					title: raw.title,
					owner,
					createdByAgent: this._created.has(raw.targetId),
					active: detection?.visible.has(raw.targetId) ?? false,
				};
			}),
			detection: detection
				? {
						probed: detection.probed,
						failed: detection.failed,
						visible: detection.visible.size,
						authoritative: detection.authoritative,
					}
				: undefined,
		};
	}

	private async _listRawTargets(
		client: CdpClient,
		includeInternal = false,
	): Promise<Array<{ targetId: string; url: string; title: string }>> {
		const { targetInfos } = await client.sendRaw<{
			targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
		}>("Target.getTargets");
		return (targetInfos ?? []).filter((t) => t.type === "page" && (includeInternal || isRealPageUrl(t.url)));
	}

	/**
	 * Find which page(s) the user is looking at. Chrome 150+ answers from
	 * tab-strip state (no attaches at all); older Chrome falls back to
	 * per-tab visibility probing (VibeSurf's _get_active_target semantics:
	 * visibilityState === 'visible' means "the selected tab of its window"
	 * and stays true while the user types in the terminal, whereas
	 * document.hasFocus() goes false). EVERY visible tab is marked (one per
	 * browser window when several are open — which window is frontmost is
	 * not exposed, so the caller picks by context). Owned tabs are probed on
	 * their existing sessions; unowned tabs get one cached probe session
	 * each (the first attach may surface Chrome's one-time consent dialog).
	 */
	private async _detectActiveTargets(
		client: CdpClient,
		rawTargets: Array<{ targetId: string; url: string; title: string }>,
	): Promise<{ visible: Set<string>; probed: number; failed: number; authoritative?: boolean }> {
		// Authoritative fast path (Chrome 150+): tab-strip state straight from
		// the browser — no attaches, no consent dialogs, and immune to the
		// window-occlusion staleness that makes visibilityState report every
		// tab hidden when the browser sits on another macOS Space/screen.
		const fromTabStrip = await this._activeTabsFromEmbedderData(client, rawTargets);
		if (fromTabStrip) {
			return { visible: fromTabStrip, probed: rawTargets.length, failed: 0, authoritative: true };
		}
		const visible = new Set<string>();
		let probed = 0;
		let failed = 0;
		for (const raw of rawTargets) {
			try {
				const owner = this._owners.get(raw.targetId);
				const ownedSession = owner ? this._agents.get(owner)?.targets.get(raw.targetId) : undefined;
				const sessionId = ownedSession ?? (await this._visibilitySessionFor(client, raw.targetId));
				if (!sessionId) {
					// Attach failed (consent dialog unanswered → timeout).
					if (!ownedSession) {
						failed++;
					}
					continue;
				}
				const result = await client.sendRaw<{ result?: { value?: { visible?: boolean } } }>(
					"Runtime.evaluate",
					{
						expression: "({visible: document.visibilityState === 'visible' && !document.hidden})",
						returnByValue: true,
					},
					sessionId,
				);
				probed++;
				if (result.result?.value?.visible) {
					visible.add(raw.targetId);
				}
			} catch {
				// A cached session can go stale (tab navigated away from under the
				// probe, debugging revoked) — drop it so the next call re-attaches.
				failed++;
				if (!this._owners.has(raw.targetId)) {
					this._visibilitySessions.delete(raw.targetId);
				}
			}
		}
		return { visible, probed, failed };
	}

	/**
	 * Chrome 150+ (Browserbase's upstream patch) exposes the foreground tab on
	 * TAB targets: Target.getTargets with a tab filter returns
	 * embedderData.tabActive. Tab targets wrap pages, so the answer is mapped
	 * back to our page targets by URL (duplicate URLs mark both — rare and
	 * harmless). Returns undefined when the browser predates the field, so the
	 * caller falls back to visibility probing.
	 */
	private async _activeTabsFromEmbedderData(
		client: CdpClient,
		rawTargets: Array<{ targetId: string; url: string; title: string }>,
	): Promise<Set<string> | undefined> {
		try {
			const { targetInfos } = await client.sendRaw<{
				targetInfos?: Array<{
					targetId: string;
					type: string;
					url: string;
					embedderData?: { tabActive?: boolean };
				}>;
			}>("Target.getTargets", { filter: [{ type: "tab", exclude: false }, { exclude: true }] });
			const tabs = (targetInfos ?? []).filter((t) => t.type === "tab");
			if (!tabs.length || !tabs.some((t) => t.embedderData && "tabActive" in t.embedderData)) {
				return undefined;
			}
			const activeUrls = new Set(tabs.filter((t) => t.embedderData?.tabActive === true).map((t) => t.url));
			return new Set(rawTargets.filter((r) => activeUrls.has(r.url)).map((r) => r.targetId));
		} catch {
			return undefined; // filter syntax unsupported on older Chrome
		}
	}

	/** Cached probe session for a user tab, without attaching — the default-detection path. */
	private _peekVisibilitySession(client: CdpClient, targetId: string): string | undefined {
		const cached = this._visibilitySessions.get(targetId);
		return cached && cached.client === client && !client.closed ? cached.sessionId : undefined;
	}

	/**
	 * Attach ONCE per user tab and cache the session for later visibility
	 * probes (see _visibilitySessions). Goes through the attach mutex like
	 * every other attach. Returns undefined when the attach fails.
	 */
	private async _visibilitySessionFor(client: CdpClient, targetId: string): Promise<string | undefined> {
		const cached = this._peekVisibilitySession(client, targetId);
		if (cached) {
			return cached;
		}
		try {
			const sessionId = await this._attachTarget(client, targetId);
			this._visibilitySessions.set(targetId, { client, sessionId });
			return sessionId;
		} catch {
			return undefined;
		}
	}

	// ------------------------------------------------------------------
	// Events
	// ------------------------------------------------------------------

	private _bufferEventForTarget(targetId: string, event: CdpEvent): void {
		const agentId = this._owners.get(targetId);
		if (!agentId) {
			return;
		}
		const state = this._agents.get(agentId);
		if (!state) {
			return;
		}
		state.events.push(event);
		if (state.events.length > EVENT_BUFFER_SIZE) {
			state.events.splice(0, state.events.length - EVENT_BUFFER_SIZE);
		}
	}

	/** Drain and clear the agent's buffered CDP events. */
	drainEvents(agentId: string): CdpEvent[] {
		const state = this._agentState(agentId);
		const events = state.events;
		state.events = [];
		return events;
	}

	// ------------------------------------------------------------------
	// Teardown
	// ------------------------------------------------------------------

	private _releaseTarget(targetId: string, reason: string): void {
		const agentId = this._owners.get(targetId);
		this._owners.delete(targetId);
		this._created.delete(targetId);
		// Probe sessions on user tabs survive an agent merely detaching — the
		// tab itself is still alive and the cached session stays reusable.
		if (reason !== "agent-detached") {
			this._visibilitySessions.delete(targetId);
		}
		for (const [sessionId, mappedTarget] of this._sessionToTarget) {
			if (mappedTarget === targetId) {
				this._sessionToTarget.delete(sessionId);
			}
		}
		if (agentId) {
			const state = this._agents.get(agentId);
			if (state) {
				state.targets.delete(targetId);
				// Keep the logical focus pointing at a live tab.
				if (state.focusTargetId === targetId) {
					state.focusTargetId = state.targets.keys().next().value as string | undefined;
				}
				state.events.push({ method: "Vsurf.tabReleased", params: { targetId, reason } });
			}
		}
		this._locks.delete(targetId);
	}

	/** Close a tab the agent owns (ownership-checked; used for quota self-management). */
	async closeOwnedTab(agentId: string, targetId: string): Promise<void> {
		this._resolveOwnedTarget(agentId, targetId);
		const client = await this._ensureClient(agentId);
		try {
			await client.sendRaw("Target.closeTarget", { targetId });
		} finally {
			// targetDestroyed will also fire; releasing here is idempotent.
			this._releaseTarget(targetId, "closed-by-agent");
		}
	}

	/**
	 * Detach an agent entirely: close tabs it created (on ITS connection),
	 * merely release tabs it adopted. Called when the agent's session ends
	 * (child agents cascade). Other agents and other browsers are untouched.
	 */
	async detachSession(agentId: string): Promise<void> {
		const state = this._agents.get(agentId);
		if (!state) {
			return;
		}
		const client = this._clientFor(agentId);
		const closePromises: Promise<unknown>[] = [];
		for (const targetId of state.targets.keys()) {
			if (this._created.has(targetId) && client) {
				closePromises.push(client.sendRaw("Target.closeTarget", { targetId }).catch(() => {}));
			}
		}
		await Promise.all(closePromises);
		for (const targetId of [...state.targets.keys()]) {
			this._releaseTarget(targetId, "agent-detached");
		}
		this._agents.delete(agentId);
		// Unbind; the connection stays up for its remaining agents.
		const key = this._agentConnection.get(agentId);
		if (key) {
			this._agentConnection.delete(agentId);
			const conn = this._connections.get(key);
			conn?.agents.delete(agentId);
		}
	}

	/**
	 * Rebind ONE agent to a fresh browser: close its created tabs on the old
	 * connection, release everything, unbind. The next operation re-runs the
	 * connection provider (re-prompting when the preference was cleared).
	 * Other agents keep their connections and tabs.
	 */
	async resetAgent(agentId: string): Promise<void> {
		await this.detachSession(agentId);
	}

	/** Release all agents and drop every connection. Managed browser processes are owned by the wiring layer. */
	async close(): Promise<void> {
		for (const agentId of [...this._agents.keys()]) {
			await this.detachSession(agentId);
		}
		for (const conn of this._connections.values()) {
			conn.client.close();
		}
		this._connections.clear();
		this._agentConnection.clear();
	}

	private _translateError(error: unknown, method: string): Error {
		if (error instanceof BrowserError) {
			return error;
		}
		const message = error instanceof Error ? error.message : String(error);
		if (/(target|session).*(closed|not found|gone|detached)|no target with given id/i.test(message)) {
			return new BrowserError("TAB_DESTROYED", `Tab went away during ${method}: ${message}`);
		}
		return new BrowserError("CDP_ERROR", `${method} failed: ${message}`);
	}
}
