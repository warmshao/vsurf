/**
 * Headless smoke test of the full browser connection orchestration:
 * no settings, no prompt fn → should silently launch a managed browser,
 * connect, navigate, screenshot, and clean up. Run with: npx tsx <this file>
 */
import { BrowserManager } from "../src/core/browser/browser-manager.js";
import { createConnectionProvider, killManagedBrowser } from "../src/core/browser/connection.js";
import { createBrowserHostHandlers } from "../src/core/browser/host-handlers.js";

const manager = new BrowserManager(
	createConnectionProvider({
		readSettings: () => undefined,
		writeSettings: (s) => console.log("[settings] would persist:", s),
		getPromptFn: () => undefined, // headless: no UI, expect managed-launch fallback
	}),
);

const handlers = createBrowserHostHandlers({
	manager,
	agentId: "smoke-agent",
	rlmDepth: 0,
	modelSupportsVision: () => true,
});

try {
	console.log("[1] ensure_session (expect managed launch, no prompt)…");
	const session = await handlers["browser.ensure_session"]({});
	console.log("    target_id:", session.target_id);

	console.log("[2] goto example.com…");
	await handlers["browser.goto_url"]({ url: "https://example.com" });
	const info = await handlers["browser.page_info"]({});
	console.log("    page_info:", info.title, "|", info.url);

	console.log("[3] dom()…");
	const dom = await handlers["browser.dom"]({});
	console.log("    elements:", dom.element_count, "| first lines:", String(dom.elements_text).split("\n").slice(0, 2).join(" / "));

	console.log("[4] screenshot…");
	const shot = await handlers["browser.screenshot"]({});
	console.log("    jpeg base64 bytes:", String(shot.data).length);

	console.log("[5] detach (created tab should close)…");
	await manager.detachSession("smoke-agent");
	const tabs = await manager.listTabs("smoke-agent", "mine", 0);
	console.log("    remaining tabs for agent:", tabs.tabs.length);

	console.log("SMOKE OK");
} finally {
	await manager.close().catch(() => {});
	killManagedBrowser();
}
process.exit(0);
