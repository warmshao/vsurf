/**
 * Live repro for active-tab detection across REPEATED list_tabs(scope="all")
 * calls — the reported symptom is "first ask detects the active tab, later
 * asks don't". Runs against a managed browser (no consent dialogs) so only
 * our own logic is exercised:
 *
 *   1. two unowned "user" tabs are created via a side CDP connection
 *   2. list_tabs #1: expect the front tab marked active
 *   3. activate the other tab (simulates the user switching), list_tabs #2:
 *      expect the marker to MOVE — proves cached probe sessions re-evaluate
 *   4. adopt one tab (attach_tab), switch back, list_tabs #3: expect the
 *      marker on the unowned tab — proves adopted-tab probing doesn't wedge
 *      later detection
 *
 * Run with: npx tsx scripts/repro-active-detection.ts
 */
import { BrowserManager } from "../src/core/browser/browser-manager.js";
import { CdpClient } from "../src/core/browser/cdp-client.js";
import { createConnectionProvider, killManagedBrowser } from "../src/core/browser/connection.js";
import { createBrowserHostHandlers } from "../src/core/browser/host-handlers.js";

const AGENT = "repro-agent";
const manager = new BrowserManager(
	createConnectionProvider({
		readSettings: () => undefined,
		writeSettings: () => {},
		getPromptFn: () => undefined, // headless → managed launch
	}),
);
const handlers = createBrowserHostHandlers({
	manager,
	agentId: AGENT,
	rlmDepth: 0,
	modelSupportsVision: () => true,
});

interface ListedTab {
	target_id: string;
	url: string;
	active?: boolean;
}

function activeOf(result: { tabs: ListedTab[] }): ListedTab[] {
	return result.tabs.filter((t) => t.active);
}

function expectActive(label: string, result: { tabs: ListedTab[] }, urlPart: string): void {
	const actives = activeOf(result);
	const hit = actives.find((t) => t.url.includes(urlPart));
	if (hit) {
		console.log(`    OK ${label}: active = ${hit.url}`);
		return;
	}
	console.log(
		`    FAIL ${label}: expected active *${urlPart}*, got`,
		actives.map((t) => t.url),
		"detection note:",
		(result as Record<string, unknown>).active_detection_note ?? "(none)",
	);
	process.exitCode = 1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let ctl: CdpClient | undefined;
const sideTabIds: string[] = [];
try {
	console.log("[setup] managed launch + agent tab…");
	await handlers["browser.ensure_session"]({});
	const wsUrl = manager.connectionKeyFor(AGENT);
	if (!wsUrl) throw new Error("no connection key");
	ctl = await CdpClient.connect(wsUrl); // side channel = "the user"

	console.log("[setup] two unowned user tabs (example.com / example.org)…");
	const t1 = (await ctl.sendRaw<{ targetId: string }>("Target.createTarget", { url: "https://example.com", background: true })).targetId;
	const t2 = (await ctl.sendRaw<{ targetId: string }>("Target.createTarget", { url: "https://example.org", background: true })).targetId;
	sideTabIds.push(t1, t2);
	await sleep(1500); // let pages load

	console.log("[1] first list_tabs(scope=all) — activate example.com first…");
	await ctl.sendRaw("Target.activateTarget", { targetId: t1 });
	await sleep(300);
	const r1 = (await handlers["browser.list_tabs"]({ scope: "all" })) as { tabs: ListedTab[]; browser?: string };
	if (r1.browser === "managed browser") {
		console.log("    OK browser label:", r1.browser);
	} else {
		console.log("    FAIL browser label: got", r1.browser);
		process.exitCode = 1;
	}
	expectActive("#1", r1, "example.com");

	console.log("[2] user switches to example.org, list_tabs again…");
	await ctl.sendRaw("Target.activateTarget", { targetId: t2 });
	await sleep(300);
	const r2 = (await handlers["browser.list_tabs"]({ scope: "all" })) as { tabs: ListedTab[] };
	expectActive("#2", r2, "example.org");

	console.log("[3] agent adopts example.org, user switches back to example.com…");
	await handlers["browser.attach_tab"]({ target_id: t2 });
	await ctl.sendRaw("Target.activateTarget", { targetId: t1 });
	await sleep(300);
	const r3 = (await handlers["browser.list_tabs"]({ scope: "all" })) as { tabs: ListedTab[] };
	expectActive("#3", r3, "example.com");

	console.log("[4] and once more (cache reuse after adoption)…");
	await ctl.sendRaw("Target.activateTarget", { targetId: t2 });
	await sleep(300);
	const r4 = (await handlers["browser.list_tabs"]({ scope: "all" })) as { tabs: ListedTab[] };
	expectActive("#4", r4, "example.org");

	console.log("[5] main agent operates an UNOWNED user tab directly (auto-adopt)…");
	// Fresh agent with no tabs at all: page_info(target_id=user tab) must
	// adopt on the fly instead of failing "not assigned".
	const handlers2 = createBrowserHostHandlers({
		manager,
		agentId: "repro-agent-2",
		rlmDepth: 0,
		modelSupportsVision: () => true,
	});
	const info = (await handlers2["browser.page_info"]({ target_id: t1 })) as { url?: string };
	if (info.url?.includes("example.com")) {
		console.log(`    OK #5: auto-adopted user tab, page_info url = ${info.url}`);
	} else {
		console.log(`    FAIL #5: unexpected page_info result`, info);
		process.exitCode = 1;
	}

	console.log(process.exitCode ? "REPRO FAILED" : "REPRO OK");
} finally {
	// Close the side-channel tabs — the managed profile persists across runs.
	for (const id of sideTabIds) {
		await ctl?.sendRaw("Target.closeTarget", { targetId: id }).catch(() => {});
	}
	ctl?.close();
	await manager.close().catch(() => {});
	killManagedBrowser();
}
process.exit(process.exitCode ?? 0);
