/**
 * Process-wide shared BrowserManager singleton.
 *
 * One browser connection multiplexes every AgentSession's tabs. The manager
 * is created lazily on first browser use; the interactive prompt fn is
 * registered by whichever session hosts the TUI (headless sessions never
 * register one, and the connection provider falls back to a managed launch).
 */

import type { SettingsManager } from "../settings-manager.js";
import { BrowserManager } from "./browser-manager.js";
import { type BrowserPromptFn, createConnectionProvider } from "./connection.js";

let _manager: BrowserManager | undefined;
let _promptFn: BrowserPromptFn | undefined;
let _forcePromptOnce = false;

export function registerBrowserPromptFn(fn: BrowserPromptFn | undefined): void {
	_promptFn = fn;
}

/**
 * Make the NEXT browser connection show the choice dialog even though a
 * preference is persisted — set by an explicit browser.reconnect().
 */
export function forceBrowserPromptOnNextConnect(): void {
	_forcePromptOnce = true;
}

export function getSharedBrowserManager(settingsManager: SettingsManager): BrowserManager {
	if (!_manager) {
		_manager = new BrowserManager(
			createConnectionProvider({
				readSettings: () => settingsManager.getBrowserSettings(),
				writeSettings: (settings) => settingsManager.setBrowserSettings(settings),
				getPromptFn: () => _promptFn,
				consumeForcePrompt: () => {
					const value = _forcePromptOnce;
					_forcePromptOnce = false;
					return value;
				},
			}),
		);
	}
	return _manager;
}

/** Test hook: drop the singleton so each test gets a fresh manager. */
export function resetSharedBrowserManager(): void {
	void _manager?.close().catch(() => {});
	_manager = undefined;
	_promptFn = undefined;
}

/**
 * Detach one agent's tabs (close created, release adopted) when its session
 * ends. No-op when no manager was ever created — sessions that never touched
 * the browser must not lazily create one just to be cleaned up.
 */
export function detachAgentBrowserSession(agentId: string): void {
	if (!_manager) {
		return;
	}
	void _manager.detachSession(agentId).catch(() => {});
}
