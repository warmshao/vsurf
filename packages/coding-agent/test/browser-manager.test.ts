/**
 * Integration tests for the browser layer: CdpClient + BrowserManager +
 * host handlers against a real headless Chrome.
 *
 * Skipped entirely when no system Chrome/Edge/Chromium binary exists.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSystemBrowser } from "../src/core/browser/browser-launcher.js";
import { BrowserError, BrowserManager } from "../src/core/browser/browser-manager.js";
import { CdpClient, resolveHttpEndpointToWs } from "../src/core/browser/cdp-client.js";
import { createBrowserHostHandlers } from "../src/core/browser/host-handlers.js";

const chromePath = findSystemBrowser();
const describeWithChrome = chromePath ? describe : describe.skip;

let chrome: ChildProcess | undefined;
let profileDir = "";
let rootClient: CdpClient | undefined;
let manager: BrowserManager | undefined;

async function waitForWsUrl(dir: string, timeoutMs = 20_000): Promise<string> {
	const activePortFile = join(dir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(activePortFile)) {
			const port = readFileSync(activePortFile, "utf-8").split(/\r?\n/)[0]?.trim();
			if (port && /^\d+$/.test(port)) {
				const wsUrl = await resolveHttpEndpointToWs(`http://127.0.0.1:${port}`, 2_000);
				if (wsUrl) {
					return wsUrl;
				}
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("headless Chrome did not open a debugging port in time");
}

describeWithChrome("browser layer (real headless Chrome)", () => {
	beforeAll(async () => {
		profileDir = mkdtempSync(join(tmpdir(), "vsurf-browser-test-"));
		chrome = spawn(
			chromePath!,
			[
				"--headless=new",
				"--remote-debugging-port=0",
				`--user-data-dir=${profileDir}`,
				"--no-first-run",
				"about:blank",
			],
			{ stdio: "ignore" },
		);
		const wsUrl = await waitForWsUrl(profileDir);
		rootClient = await CdpClient.connect(wsUrl);
		const client = rootClient;
		manager = new BrowserManager(async () => ({ client, key: "test-connection" }));
	}, 30_000);

	afterAll(async () => {
		await manager?.close().catch(() => {});
		rootClient?.close();
		chrome?.kill();
		// Chrome may hold the profile dir briefly after the kill signal.
		for (let attempt = 0; attempt < 10; attempt++) {
			try {
				rmSync(profileDir, { recursive: true, force: true });
				break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
		}
	});

	it("assigns separate tabs to two agents and isolates list_tabs", async () => {
		const a = await manager!.ensureSession("agent-a");
		const b = await manager!.ensureSession("agent-b");
		expect(a.targetId).not.toBe(b.targetId);

		const mineA = await manager!.listTabs("agent-a", "mine", 0);
		const mineB = await manager!.listTabs("agent-b", "mine", 0);
		expect(mineA.tabs.map((t) => t.targetId)).toEqual([a.targetId]);
		expect(mineB.tabs.map((t) => t.targetId)).toEqual([b.targetId]);
	});

	it("rejects cross-agent operations with NOT_OWNER", async () => {
		const b = await manager!.ensureSession("agent-b");
		await expect(
			manager!.runForAgent("agent-a", "Runtime.evaluate", { expression: "1" }, b.targetId),
		).rejects.toMatchObject({
			code: "NOT_OWNER",
		});
	});

	it("rejects unassigned targets with TARGET_NOT_FOUND", async () => {
		await expect(
			manager!.runForAgent("agent-a", "Runtime.evaluate", { expression: "1" }, "DOESNOTEXIST"),
		).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
	});

	it("forbids child agents (rlm depth > 0) from adopting tabs", async () => {
		const { targetInfos } = await rootClient!.sendRaw<{ targetInfos: Array<{ targetId: string; type: string }> }>(
			"Target.getTargets",
		);
		const userPage = targetInfos.find((t) => t.type === "page");
		expect(userPage).toBeDefined();
		await expect(manager!.attachTab("agent-child", userPage!.targetId, 1)).rejects.toMatchObject({
			code: "ADOPT_NOT_ALLOWED",
		});
	});

	it("lets the main agent adopt a user tab without owning its lifecycle", async () => {
		const { targetId } = await rootClient!.sendRaw<{ targetId: string }>("Target.createTarget", {
			url: "about:blank",
		});
		const adopted = await manager!.attachTab("agent-main", targetId, 0);
		expect(adopted.targetId).toBe(targetId);

		// Detach releases but must NOT close the adopted tab.
		await manager!.detachSession("agent-main");
		const { targetInfos } = await rootClient!.sendRaw<{ targetInfos: Array<{ targetId: string }> }>(
			"Target.getTargets",
		);
		expect(targetInfos.some((t) => t.targetId === targetId)).toBe(true);
		await rootClient!.sendRaw("Target.closeTarget", { targetId });
	});

	it("auto-releases a tab destroyed externally and reports TAB_DESTROYED", async () => {
		const { targetId } = await manager!.createTab("agent-c", "about:blank");
		await rootClient!.sendRaw("Target.closeTarget", { targetId });
		// Wait for the targetDestroyed event to propagate.
		await new Promise((resolve) => setTimeout(resolve, 500));
		await expect(
			manager!.runForAgent("agent-c", "Runtime.evaluate", { expression: "1" }, targetId),
		).rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
	});

	it("enforces the per-agent tab quota", async () => {
		for (let i = 0; i < 5; i++) {
			await manager!.createTab("agent-quota", "about:blank");
		}
		await expect(manager!.createTab("agent-quota", "about:blank")).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
		await manager!.detachSession("agent-quota");
	});

	it("closes agent-created tabs on detachSession", async () => {
		const { targetId } = await manager!.createTab("agent-d", "about:blank");
		await manager!.detachSession("agent-d");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const { targetInfos } = await rootClient!.sendRaw<{ targetInfos: Array<{ targetId: string }> }>(
			"Target.getTargets",
		);
		expect(targetInfos.some((t) => t.targetId === targetId)).toBe(false);
	});

	it("navigates, evaluates JS, and takes screenshots through host handlers", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-e",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		await handlers["browser.ensure_session"]({});
		await handlers["browser.goto_url"]({
			url: "data:text/html,<title>hello</title><button id='b' onclick='window.__clicked=1'>Click me</button>",
		});
		await new Promise((resolve) => setTimeout(resolve, 300));

		const info = await handlers["browser.page_info"]({});
		expect(info.url).toMatch(/^data:text\/html/);
		expect(info.title).toBe("hello");

		const shot = await handlers["browser.screenshot"]({});
		expect(typeof shot.data).toBe("string");
		expect((shot.data as string).length).toBeGreaterThan(1000);
	});

	it("guides text-only models away from screenshots", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-e",
			rlmDepth: 0,
			modelSupportsVision: () => false,
		});
		const shot = await handlers["browser.screenshot"]({});
		expect(shot.vision_unsupported).toBe(true);
		expect(String(shot.hint)).toContain("dom()");
	});

	it("dom() lists interactive elements and click_index clicks them", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-e",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		await handlers["browser.goto_url"]({
			url: "data:text/html,<button style='width:200px;height:40px' onclick='window.__clicked=1'>Hit me</button>",
		});
		await new Promise((resolve) => setTimeout(resolve, 300));

		const domResult = await handlers["browser.dom"]({});
		expect(domResult.element_count).toBeGreaterThan(0);
		expect(String(domResult.elements_text)).toContain("Hit me");

		await handlers["browser.click_index"]({ index: 0 });
		const clicked = await handlers["browser.js"]({ expression: "window.__clicked === 1" });
		expect(clicked.result).toBe(true);
	});

	it("click_index without a snapshot returns STALE_INDEX", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-fresh",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		await expect(handlers["browser.click_index"]({ index: 0 })).rejects.toThrow(/STALE_INDEX/);
	});

	it("blocks the raw cdp() escape hatch on foreign tabs", async () => {
		const b = await manager!.ensureSession("agent-b");
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-a",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		await expect(
			handlers["browser.cdp"]({ method: "Runtime.evaluate", params: { expression: "1" }, target_id: b.targetId }),
		).rejects.toThrow(/NOT_OWNER/);
	});

	it("surfaces BrowserError codes through the handler error channel", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-a",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		await expect(handlers["browser.cdp"]({ method: "Bogus.method" })).rejects.toThrow(/\[CDP_ERROR\]/);
		const err: unknown = await handlers["browser.attach_tab"]({ target_id: "x" }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(String((err as Error).message)).toMatch(/\[TARGET_NOT_FOUND\]/);
	});

	it("keeps BrowserError type for direct manager use", () => {
		expect(new BrowserError("NOT_OWNER", "x").code).toBe("NOT_OWNER");
	});

	it("new tabs take the agent's logical focus (targetless ops hit the newest tab)", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-focus",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		await handlers["browser.new_tab"]({ url: "about:blank" });
		const second = await handlers["browser.new_tab"]({
			url: "data:text/html,<title>second-tab</title><p>hi</p>",
		});
		// Targetless page_info must hit the SECOND tab.
		const info = await handlers["browser.page_info"]({});
		expect(info.title).toBe("second-tab");

		const mine = await handlers["browser.list_tabs"]({});
		const tabs = mine.tabs as Array<{ target_id: string; focused?: boolean }>;
		expect(tabs.find((t) => t.focused)?.target_id).toBe(second.target_id);
	});

	it("focus_tab switches the logical focus without activating anything", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-focus",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		const mine = await handlers["browser.list_tabs"]({});
		const tabs = mine.tabs as Array<{ target_id: string; focused?: boolean }>;
		const other = tabs.find((t) => !t.focused)!;
		await handlers["browser.focus_tab"]({ target_id: other.target_id });
		const after = await handlers["browser.list_tabs"]({});
		expect((after.tabs as Array<{ target_id: string; focused?: boolean }>).find((t) => t.focused)?.target_id).toBe(
			other.target_id,
		);
		// Focus on a foreign tab is rejected.
		const b = await manager!.ensureSession("agent-b");
		await expect(handlers["browser.focus_tab"]({ target_id: b.targetId })).rejects.toThrow(/NOT_OWNER/);
	});

	it("focus falls back to a live tab when the focused tab dies", async () => {
		const first = await manager!.ensureSession("agent-focusfall");
		const second = await manager!.createTab("agent-focusfall", "about:blank");
		// second has focus; kill it externally.
		await rootClient!.sendRaw("Target.closeTarget", { targetId: second.targetId });
		await new Promise((resolve) => setTimeout(resolve, 500));
		const info = await manager!.runForAgent<{ result?: { value?: string } }>("agent-focusfall", "Runtime.evaluate", {
			expression: "location.href",
			returnByValue: true,
		});
		expect(info.result?.value).toBeDefined();
		const mine = await manager!.listTabs("agent-focusfall", "mine", 0);
		expect(mine.tabs.map((t) => t.targetId)).toEqual([first.targetId]);
		expect(mine.tabs[0]!.focused).toBe(true);
	});

	it("scrolls a background tab via JS (CDP wheel events are dropped when hidden)", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-scroll",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		// 3000px-tall page; the tab stays in the background the whole time.
		await handlers["browser.new_tab"]({
			url: "data:text/html,<body style='margin:0'><div style='height:3000px;background:linear-gradient(red,blue)'></div></body>",
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		const before = await handlers["browser.js"]({ expression: "window.scrollY" });
		expect(before.result).toBe(0);
		const scrolled = await handlers["browser.scroll"]({ dy: 800 });
		expect((scrolled.scroll_y as number) >= 800).toBe(true);
		const back = await handlers["browser.scroll"]({ dy: -800 });
		expect(back.scroll_y).toBe(0);
	});

	it("dom() covers below-fold elements and click_index scrolls to them", async () => {
		const handlers = createBrowserHostHandlers({
			manager: manager!,
			agentId: "agent-fold",
			rlmDepth: 0,
			modelSupportsVision: () => true,
		});
		await handlers["browser.new_tab"]({
			url: "data:text/html,<body style='margin:0'><div style='height:2500px'></div><button style='width:200px;height:40px' onclick='window.__clicked=1'>Deep button</button></body>",
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		const domResult = (await handlers["browser.dom"]({})) as Record<string, unknown>;
		const text = String(domResult.elements_text);
		expect(text).toContain("Deep button");
		expect(text).toContain("[below-fold]");
		// Clicking it must scroll it into view and land the click.
		await handlers["browser.click_index"]({ index: 0 });
		const clicked = await handlers["browser.js"]({ expression: "window.__clicked === 1" });
		expect(clicked.result).toBe(true);
		const scrollY = await handlers["browser.js"]({ expression: "window.scrollY" });
		expect((scrollY.result as number) > 0).toBe(true);
	});

	it("multi-connection: resetAgent rebinds only that agent, others keep their tabs", async () => {
		let currentKey = "conn-1";
		const m = new BrowserManager(async () => ({ client: rootClient!, key: currentKey }));
		const x = await m.createTab("agent-x", "about:blank");
		currentKey = "conn-2";
		const y = await m.createTab("agent-y", "about:blank");
		expect(m.connectionKeyFor("agent-x")).toBe("conn-1");
		expect(m.connectionKeyFor("agent-y")).toBe("conn-2");

		await m.resetAgent("agent-x");
		await new Promise((resolve) => setTimeout(resolve, 500));
		const { targetInfos } = await rootClient!.sendRaw<{ targetInfos: Array<{ targetId: string }> }>(
			"Target.getTargets",
		);
		// agent-x's created tab was closed on rebind; agent-y is untouched.
		expect(targetInfos.some((t) => t.targetId === x.targetId)).toBe(false);
		expect(targetInfos.some((t) => t.targetId === y.targetId)).toBe(true);
		expect(m.connectionKeyFor("agent-x")).toBeUndefined();
		expect(m.connectionKeyFor("agent-y")).toBe("conn-2");
		await m.detachSession("agent-y");
	});
});
