/**
 * Locate, launch, or download a Chromium-based browser for automation.
 *
 * Connection philosophy (from browser-harness install.md, verified against
 * Chrome's behavior):
 * - Attaching to the user's everyday browser keeps their logins but requires
 *   the chrome://inspect checkbox (Chrome 144+ shows an Allow popup on attach).
 * - A managed launch uses `--remote-debugging-port` + a NON-default
 *   user-data-dir (Chrome 136+ silently no-ops the port flag on the default
 *   profile), is popup-free, but starts with a clean profile.
 *
 * Binary resolution order: explicit settings override → system Chrome/Edge/
 * Brave/Chromium → download Chrome for Testing via @puppeteer/browsers.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../../config.js";
import { resolveHttpEndpointToWs } from "./cdp-client.js";

const LAUNCH_TIMEOUT_MS = 30_000;

/** user-data-dir for the managed browser instance. Deliberately NOT any browser's default profile. */
export function getManagedProfileDir(): string {
	return join(getAgentDir(), "browser-profile");
}

function getDownloadedBrowsersDir(): string {
	return join(getAgentDir(), "browsers");
}

// ---------------------------------------------------------------------------
// System browser detection
// ---------------------------------------------------------------------------

function windowsBrowserPaths(): Array<{ label: string; path: string }> {
	const programFiles = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(
		(dir): dir is string => typeof dir === "string" && dir.length > 0,
	);
	const suffixes: Array<{ label: string; suffix: string }> = [
		{ label: "Google Chrome", suffix: "Google/Chrome/Application/chrome.exe" },
		{ label: "Microsoft Edge", suffix: "Microsoft/Edge/Application/msedge.exe" },
		{ label: "Brave", suffix: "BraveSoftware/Brave-Browser/Application/brave.exe" },
		{ label: "Chromium", suffix: "Chromium/Application/chrome.exe" },
	];
	const paths: Array<{ label: string; path: string }> = [];
	for (const base of programFiles) {
		for (const { label, suffix } of suffixes) {
			paths.push({ label, path: join(base, suffix) });
		}
	}
	return paths;
}

function macBrowserPaths(): Array<{ label: string; path: string }> {
	return [
		{ label: "Google Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
		{ label: "Microsoft Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
		{ label: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
		{ label: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
	];
}

function linuxBrowserPaths(): Array<{ label: string; path: string }> {
	const home = homedir();
	return [
		{ label: "Google Chrome", path: "/usr/bin/google-chrome" },
		{ label: "Google Chrome", path: "/usr/bin/google-chrome-stable" },
		{ label: "Chromium", path: "/usr/bin/chromium" },
		{ label: "Chromium", path: "/usr/bin/chromium-browser" },
		{ label: "Microsoft Edge", path: "/usr/bin/microsoft-edge" },
		{ label: "Brave", path: "/usr/bin/brave-browser" },
		{ label: "Chromium", path: "/snap/bin/chromium" },
		{ label: "Google Chrome", path: join(home, ".local/bin/chrome") },
	];
}

function systemBrowserCandidates(): Array<{ label: string; path: string }> {
	switch (platform()) {
		case "win32":
			return windowsBrowserPaths();
		case "darwin":
			return macBrowserPaths();
		default:
			return linuxBrowserPaths();
	}
}

/** All installed system browsers, deduplicated by label, in preference order. */
export function findSystemBrowsers(): Array<{ label: string; path: string }> {
	const seen = new Set<string>();
	const found: Array<{ label: string; path: string }> = [];
	for (const { label, path } of systemBrowserCandidates()) {
		if (!seen.has(label) && existsSync(path)) {
			seen.add(label);
			found.push({ label, path });
		}
	}
	return found;
}

/** First existing system browser binary, or undefined. */
export function findSystemBrowser(): string | undefined {
	return findSystemBrowsers()[0]?.path;
}

// ---------------------------------------------------------------------------
// Managed download (Chrome for Testing via @puppeteer/browsers)
// ---------------------------------------------------------------------------

/** Path of a previously downloaded Chrome for Testing build, if present. */
export function findDownloadedBrowser(): string | undefined {
	const root = getDownloadedBrowsersDir();
	if (!existsSync(root)) {
		return undefined;
	}
	// Layout: <root>/chrome/<platform>-<arch>-<version>/...
	// Delegate the exact path computation to @puppeteer/browsers at launch time;
	// here we only need a cheap existence probe for UI purposes.
	try {
		for (const channel of readdirSync(root)) {
			const channelDir = join(root, channel);
			for (const build of readdirSync(channelDir)) {
				const found = findSystemBrowserInBuildDir(join(channelDir, build));
				if (found) {
					return found;
				}
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function findSystemBrowserInBuildDir(buildDir: string): string | undefined {
	const relative =
		platform() === "win32"
			? ["chrome-win64/chrome.exe", "chrome-win32/chrome.exe"]
			: platform() === "darwin"
				? [
						"chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
						"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
					]
				: ["chrome-linux64/chrome", "chrome-linux/chrome"];
	for (const rel of relative) {
		const candidate = join(buildDir, rel);
		if (existsSync(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** Download Chrome for Testing into the agent dir. Returns the executable path. */
export async function downloadBrowser(
	onProgress?: (downloadedBytes: number, totalBytes: number) => void,
): Promise<string> {
	// Imported lazily: @puppeteer/browsers is only needed on machines with no
	// system browser, and it pulls a sizable dependency tree.
	const { install, resolveBuildId, detectBrowserPlatform, Browser, ChromeReleaseChannel } = await import(
		"@puppeteer/browsers"
	);
	const browserPlatform = detectBrowserPlatform();
	if (!browserPlatform) {
		throw new Error(`Unsupported platform for browser download: ${platform()}`);
	}
	const buildId = await resolveBuildId(Browser.CHROME, browserPlatform, ChromeReleaseChannel.STABLE);
	const result = await install({
		browser: Browser.CHROME,
		buildId,
		cacheDir: getDownloadedBrowsersDir(),
		downloadProgressCallback: onProgress,
	});
	return result.executablePath;
}

// ---------------------------------------------------------------------------
// Managed launch
// ---------------------------------------------------------------------------

export interface LaunchedBrowser {
	wsUrl: string;
	process: ChildProcess;
	executablePath: string;
	profileDir: string;
}

/**
 * Launch a managed browser instance with remote debugging on an ephemeral port
 * and a dedicated (non-default!) profile dir, then resolve its CDP websocket
 * URL from the DevToolsActivePort file Chrome writes into the profile dir.
 */
export async function launchManagedBrowser(executablePath: string): Promise<LaunchedBrowser> {
	const profileDir = getManagedProfileDir();
	mkdirSync(profileDir, { recursive: true });
	const child = spawn(
		executablePath,
		[
			"--remote-debugging-port=0",
			`--user-data-dir=${profileDir}`,
			"--no-first-run",
			"--no-default-browser-check",
			// Keep background tabs rendering: agents operate silently in the
			// background, and Chromium otherwise suspends the compositor for
			// hidden/occluded tabs — Page.captureScreenshot then stalls for
			// many seconds waiting for a frame (worst on Windows, where native
			// occlusion detection stops rendering covered windows entirely).
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
			"--disable-renderer-backgrounding",
			"--disable-features=CalculateNativeWinOcclusion",
			"about:blank",
		],
		{ stdio: "ignore", windowsHide: false },
	);
	const wsUrl = await waitForDevToolsPort(profileDir, LAUNCH_TIMEOUT_MS);
	return { wsUrl, process: child, executablePath, profileDir };
}

async function waitForDevToolsPort(profileDir: string, timeoutMs: number): Promise<string> {
	const activePortFile = join(profileDir, "DevToolsActivePort");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(activePortFile)) {
			try {
				const port = readFileSync(activePortFile, "utf-8").split(/\r?\n/)[0]?.trim();
				if (port && /^\d+$/.test(port)) {
					const wsUrl = await resolveHttpEndpointToWs(`http://127.0.0.1:${port}`, 2_000);
					if (wsUrl) {
						return wsUrl;
					}
				}
			} catch {
				// file mid-write; keep polling
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Browser did not open a debugging port within ${timeoutMs / 1000}s`);
}

// ---------------------------------------------------------------------------
// Convenience: open a URL in the user's default browser (chrome://inspect guidance)
// ---------------------------------------------------------------------------

/** Best-effort open of a URL in the user's default browser. Never throws. */
export function openUrlInDefaultBrowser(url: string): boolean {
	try {
		const command = platform() === "win32" ? "cmd" : platform() === "darwin" ? "open" : "xdg-open";
		const args = platform() === "win32" ? ["/c", "start", "", url] : [url];
		const result = spawnSync(command, args, { stdio: "ignore", windowsHide: true });
		return !result.error;
	} catch {
		return false;
	}
}
