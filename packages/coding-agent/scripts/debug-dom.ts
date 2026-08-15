/** Debug dom() against github.com — see what the snippet really returns. */
import { BrowserManager } from "../src/core/browser/browser-manager.js";
import { createConnectionProvider, killManagedBrowser } from "../src/core/browser/connection.js";
import { createBrowserHostHandlers } from "../src/core/browser/host-handlers.js";

const manager = new BrowserManager(
	createConnectionProvider({
		readSettings: () => undefined,
		writeSettings: () => {},
		getPromptFn: () => undefined,
	}),
);
const handlers = createBrowserHostHandlers({ manager, agentId: "dbg", rlmDepth: 0, modelSupportsVision: () => true });

try {
	await handlers["browser.ensure_session"]({});
	await handlers["browser.goto_url"]({ url: "https://github.com/browser-use/browser-use" });
	await new Promise((r) => setTimeout(r, 3000));
	const dom = (await handlers["browser.dom"]({ max_elements: 100 })) as Record<string, unknown>;
	console.log("element_count:", dom.element_count, "truncated:", dom.truncated);
	console.log("elements_text (first 25 lines):");
	console.log(String(dom.elements_text).split("\n").slice(0, 25).join("\n"));
	console.log("scrollables:", JSON.stringify(dom.scrollables));

	// Raw candidate counts for diagnosis
	const diag = (await handlers["browser.js"]({
		expression: `(() => {
			const sels = "a, button, input, select, textarea, details, summary, option, [role], [tabindex], [onclick], label, iframe";
			const all = [...document.querySelectorAll(sels)];
			const vis = all.filter(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
				return r.width >= 2 && r.height >= 2 && s.display !== "none" && s.visibility !== "hidden"; });
			const inView = vis.filter(el => { const r = el.getBoundingClientRect();
				return !(r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth); });
			const occludedPass = inView.filter(el => { const r = el.getBoundingClientRect();
				const cx = Math.round(r.left + r.width/2), cy = Math.round(r.top + r.height/2);
				if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) return false;
				const hit = document.elementFromPoint(cx, cy);
				return !hit || hit === el || el.contains(hit) || hit.contains(el); });
			return { total: all.length, visible: vis.length, inView: inView.length, occlusionPass: occludedPass.length, vw: innerWidth, vh: innerHeight };
		})()`,
	})) as Record<string, unknown>;
	console.log("diagnosis:", JSON.stringify(diag.result));
} finally {
	await manager.close().catch(() => {});
	killManagedBrowser();
}
process.exit(0);
