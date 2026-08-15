/**
 * Connection orchestration for the shared BrowserManager.
 *
 * Order of attempts (browser-harness install.md's "try yourself before asking"):
 * 1. VSURF_BROWSER_CDP_URL env override
 * 2. Persisted settings preference (attach / endpoint / launch)
 * 3. Silent discovery — the user may have enabled debugging long ago (the
 *    chrome://inspect checkbox is sticky); if found, connect without any prompt
 * 4. First-use prompt (interactive sessions only) → persist the choice
 * 5. Headless fallback: launch a managed browser silently
 *
 * The managed browser process is tracked module-level and reused across
 * reconnects; only one managed instance ever exists per host process.
 */

import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserSettings } from "../settings-manager.js";
import {
	downloadBrowser,
	findDownloadedBrowser,
	findSystemBrowser,
	findSystemBrowsers,
	launchManagedBrowser,
} from "./browser-launcher.js";
import type { ConnectionProvider, ProvidedConnection } from "./browser-manager.js";
import { CdpClient, discoverAttachCandidates, resolveHttpEndpointToWs } from "./cdp-client.js";

export type BrowserConnectionChoice =
	| { mode: "attach"; wsUrl?: string; label?: string }
	| { mode: "launch"; binaryPath?: string }
	| { mode: "download" }
	| { mode: "endpoint"; cdpUrl: string };

/** What the first-use prompt can offer: live attachable browsers and installed launchable binaries. */
export interface BrowserPromptContext {
	attachable: Array<{ label: string; wsUrl: string }>;
	launchable: Array<{ label: string; path: string }>;
}

/** Interactive sessions register a prompt fn; headless sessions leave it unset. */
export type BrowserPromptFn = (context: BrowserPromptContext) => Promise<BrowserConnectionChoice>;

export interface ConnectionProviderDeps {
	readSettings: () => BrowserSettings | undefined;
	writeSettings: (settings: BrowserSettings) => void;
	/** Returns the currently registered interactive prompt fn, if any. */
	getPromptFn: () => BrowserPromptFn | undefined;
	/**
	 * One-shot flag: when set (e.g. by an explicit browser.reconnect()), the
	 * provider MUST show the prompt on the next connect — no silent reuse of
	 * persisted preferences or single-candidate shortcuts. Consumed on read.
	 */
	consumeForcePrompt?: () => boolean;
}

let _managed: { process: ChildProcess; profileDir: string } | undefined;

/** Kill the managed browser when the host process exits. */
let _exitHookInstalled = false;
function installExitHook(): void {
	if (_exitHookInstalled) {
		return;
	}
	_exitHookInstalled = true;
	process.on("exit", () => {
		try {
			_managed?.process.kill();
		} catch {
			// already gone
		}
	});
}

function managedProcessAlive(): boolean {
	return _managed !== undefined && _managed.process.exitCode === null && !_managed.process.killed;
}

/** Re-resolve the ws URL of the still-running managed browser (survives manager reconnects). */
async function resolveManagedWsUrl(): Promise<string | undefined> {
	if (!managedProcessAlive()) {
		return undefined;
	}
	try {
		const port = readFileSync(join(_managed!.profileDir, "DevToolsActivePort"), "utf-8").split(/\r?\n/)[0]?.trim();
		if (port && /^\d+$/.test(port)) {
			return await resolveHttpEndpointToWs(`http://127.0.0.1:${port}`, 2_000);
		}
	} catch {
		// fall through
	}
	return undefined;
}

async function launchManaged(binaryPath?: string): Promise<ProvidedConnection> {
	const existing = await resolveManagedWsUrl();
	if (existing) {
		return { client: await CdpClient.connect(existing), key: existing, label: "managed browser" };
	}
	let executable = binaryPath ?? findSystemBrowser() ?? findDownloadedBrowser();
	if (!executable || (binaryPath && !existsSync(binaryPath))) {
		if (binaryPath && !existsSync(binaryPath)) {
			throw new Error(`configured browser binaryPath does not exist: ${binaryPath}`);
		}
		executable = await downloadBrowser();
	}
	const launched = await launchManagedBrowser(executable);
	_managed = { process: launched.process, profileDir: launched.profileDir };
	installExitHook();
	return { client: await CdpClient.connect(launched.wsUrl), key: launched.wsUrl, label: "managed browser" };
}

async function pollForAttachableBrowser(timeoutMs: number, preferredLabel?: string): Promise<string | undefined> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const candidates = await discoverAttachCandidates();
		// A remembered choice is strict: silently falling back to whatever
		// browser happens to be running would surprise the user — they get the
		// prompt instead when their browser is absent.
		if (preferredLabel) {
			const preferred = candidates.find((c) => c.label === preferredLabel);
			if (preferred) {
				return preferred.wsUrl;
			}
		} else if (candidates[0]) {
			return candidates[0].wsUrl;
		}
		await new Promise((resolve) => setTimeout(resolve, 1_000));
	}
	return undefined;
}

/** Connect, returning undefined instead of throwing — discovery candidates are often stale. */
async function tryConnect(wsUrl: string | undefined, label?: string): Promise<ProvidedConnection | undefined> {
	if (!wsUrl) {
		return undefined;
	}
	try {
		return { client: await CdpClient.connect(wsUrl), key: wsUrl, ...(label ? { label } : {}) };
	} catch {
		return undefined;
	}
}

export function createConnectionProvider(deps: ConnectionProviderDeps): ConnectionProvider {
	return async () => {
		// 1. Env override always wins.
		const envUrl = process.env.VSURF_BROWSER_CDP_URL;
		if (envUrl) {
			const wsUrl = envUrl.startsWith("ws") ? envUrl : await resolveHttpEndpointToWs(envUrl);
			if (!wsUrl) {
				throw new Error(`VSURF_BROWSER_CDP_URL is set but unreachable: ${envUrl}`);
			}
			const client = await tryConnect(wsUrl, `env (${envUrl})`);
			if (!client) {
				throw new Error(`VSURF_BROWSER_CDP_URL websocket connect failed: ${wsUrl}`);
			}
			return client;
		}

		// An explicit reconnect forces the prompt regardless of what's persisted.
		const forcePrompt = deps.consumeForcePrompt?.() ?? false;

		// 2. Persisted preference.
		if (!forcePrompt) {
			const settings = deps.readSettings();
			if (settings?.mode === "endpoint" && settings.cdpUrl) {
				const client = await tryConnect(await resolveHttpEndpointToWs(settings.cdpUrl), settings.cdpUrl);
				if (client) {
					return client;
				}
				// Endpoint dead — fall through to re-prompt rather than failing hard.
			} else if (settings?.mode === "launch") {
				try {
					return await launchManaged(settings.binaryPath);
				} catch {
					// fall through to re-prompt
				}
			} else if (settings?.mode === "attach") {
				const client = await tryConnect(
					await pollForAttachableBrowser(5_000, settings.attachLabel),
					settings.attachLabel,
				);
				if (client) {
					return client;
				}
				// Browser not running / debugging off — re-prompt below.
			}
		}

		// 3. Silent discovery before ever asking the user anything. Candidates
		// are validated by HTTP ONLY (/json/version) — a CDP connect would pop
		// Chrome 144+'s "Allow remote debugging" consent in EVERY candidate
		// browser before the user has chosen anything. Exactly one candidate
		// connects silently; several means the user picks by name.
		const live = await discoverAttachCandidates();
		// A remembered attach preference that is currently absent must NOT be
		// silently replaced by whatever single browser happens to be debuggable
		// right now — the user picks again instead.
		const rememberedMissing =
			!forcePrompt &&
			deps.readSettings()?.mode === "attach" &&
			!!deps.readSettings()?.attachLabel &&
			!live.some((c) => c.label === deps.readSettings()?.attachLabel);
		if (!forcePrompt && !rememberedMissing && live.length === 1) {
			const only = await tryConnect(live[0].wsUrl, live[0].label);
			if (only) {
				return only;
			}
			// Stale candidate — fall through to the prompt.
		}

		// 4. Interactive first-use prompt. Candidates are shown by name and only
		// the PICKED one gets a real CDP connection (Chrome 144+ pops a consent
		// dialog per new CDP session — connecting to all would spam every browser).
		const promptFn = deps.getPromptFn();
		if (promptFn) {
			const choice = await promptFn({
				attachable: live.map(({ label, wsUrl }) => ({ label, wsUrl })),
				launchable: findSystemBrowsers(),
			});
			if (choice.mode === "attach") {
				// The picker always returns a specific candidate with a wsUrl.
				if (choice.wsUrl) {
					const conn = await tryConnect(choice.wsUrl, choice.label);
					if (conn) {
						deps.writeSettings(choice.label ? { mode: "attach", attachLabel: choice.label } : { mode: "attach" });
						return conn;
					}
					throw new Error(`selected browser is no longer reachable: ${choice.wsUrl}`);
				}
				throw new Error("attach choice without a browser candidate");
			}
			if (choice.mode === "endpoint") {
				const conn = await tryConnect(await resolveHttpEndpointToWs(choice.cdpUrl));
				if (!conn) {
					throw new Error(
						`CDP endpoint unreachable: ${choice.cdpUrl} (expected something like http://127.0.0.1:9222)`,
					);
				}
				deps.writeSettings({ mode: "endpoint", cdpUrl: choice.cdpUrl });
				return conn;
			}
			if (choice.mode === "download") {
				// Explicit managed download: never touches the user's installed
				// browsers. Persisted as launch+binaryPath so the next connect
				// reuses the downloaded build without re-downloading.
				const path = findDownloadedBrowser() ?? (await downloadBrowser());
				const conn = await launchManaged(path);
				deps.writeSettings({ mode: "launch", binaryPath: path });
				return conn;
			}
			// launch
			const conn = await launchManaged(choice.binaryPath);
			deps.writeSettings(choice.binaryPath ? { mode: "launch", binaryPath: choice.binaryPath } : { mode: "launch" });
			return conn;
		}

		// Headless with exactly-one-candidate already handled above; here either
		// no prompt fn or the single silent connect failed — first candidate wins.
		if (live.length > 0) {
			const conn = await tryConnect(live[0].wsUrl, live[0].label);
			if (conn) {
				return conn;
			}
		}

		// 5. Headless fallback: managed browser, no questions asked.
		return launchManaged();
	};
}

/** Dispose the shared managed browser (called on host shutdown). */
export function killManagedBrowser(): void {
	try {
		_managed?.process.kill();
	} catch {
		// already gone
	}
	_managed = undefined;
}
