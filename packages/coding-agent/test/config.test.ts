import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { delimiter, join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	detectInstallMethod,
	ENV_LEGACY_SESSION_DIR,
	ENV_SESSION_DIR,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	getSessionsDir,
	getUpdateInstruction,
} from "../src/config.js";
import { getDefaultSessionDir } from "../src/core/session-manager.js";

const execPathDescriptor = Object.getOwnPropertyDescriptor(process, "execPath");
const originalPath = process.env.PATH;
const originalPiPackageDir = process.env.VSURF_PACKAGE_DIR;
const originalSessionDir = process.env[ENV_SESSION_DIR];
const originalLegacySessionDir = process.env[ENV_LEGACY_SESSION_DIR];
let tempDir: string | undefined;

function setExecPath(value: string): void {
	Object.defineProperty(process, "execPath", {
		value,
		configurable: true,
	});
}

afterEach(() => {
	if (execPathDescriptor) {
		Object.defineProperty(process, "execPath", execPathDescriptor);
	}
	if (originalPath === undefined) {
		delete process.env.PATH;
	} else {
		process.env.PATH = originalPath;
	}
	if (originalPiPackageDir === undefined) {
		delete process.env.VSURF_PACKAGE_DIR;
	} else {
		process.env.VSURF_PACKAGE_DIR = originalPiPackageDir;
	}
	if (originalSessionDir === undefined) {
		delete process.env[ENV_SESSION_DIR];
	} else {
		process.env[ENV_SESSION_DIR] = originalSessionDir;
	}
	if (originalLegacySessionDir === undefined) {
		delete process.env[ENV_LEGACY_SESSION_DIR];
	} else {
		process.env[ENV_LEGACY_SESSION_DIR] = originalLegacySessionDir;
	}
	if (tempDir) {
		chmodSync(tempDir, 0o700);
		rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	}
});

function createNpmPrefixInstall(template = "vsurf-prefix-"): { prefix: string; packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), template));
	const root = join(prefix, "lib", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "vsurf");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.VSURF_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { prefix, packageDir };
}

function createHomebrewInstall(): { packageDir: string } {
	const prefix = mkdtempSync(join(tmpdir(), "vsurf-homebrew-"));
	const packageDir = join(prefix, "Cellar", "vsurf", "0.7.0", "libexec", "lib", "node_modules", "vsurf");
	mkdirSync(packageDir, { recursive: true });
	tempDir = prefix;
	process.env.VSURF_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createPnpmGlobalInstall(): { root: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "vsurf-pnpm-"));
	const binDir = join(temp, "bin");
	const root = join(temp, "pnpm", "global", "5", "node_modules");
	const packageDir = join(root, "@mariozechner", "vsurf");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), createFakePnpmScript(root));
	chmodSync(join(binDir, process.platform === "win32" ? "pnpm.cmd" : "pnpm"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.VSURF_PACKAGE_DIR = packageDir;
	setExecPath(
		join(root, ".pnpm", "@mariozechner+vsurf@0.0.0", "node_modules", "@mariozechner", "vsurf", "dist", "cli.js"),
	);
	return { root, packageDir };
}

function createYarnGlobalInstall(): { globalDir: string; packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "vsurf-yarn-"));
	const binDir = join(temp, "bin");
	const globalDir = join(temp, "yarn", "global");
	const packageDir = join(globalDir, "node_modules", "@mariozechner", "vsurf");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(binDir, { recursive: true });
	writeFileSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), createFakeYarnScript(globalDir));
	chmodSync(join(binDir, process.platform === "win32" ? "yarn.cmd" : "yarn"), 0o755);
	tempDir = temp;
	process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
	process.env.VSURF_PACKAGE_DIR = packageDir;
	setExecPath(join(globalDir, ".yarn", "@mariozechner", "vsurf", "dist", "cli.js"));
	return { globalDir, packageDir };
}

function createBunGlobalInstall(): { packageDir: string } {
	const temp = mkdtempSync(join(tmpdir(), "vsurf-bun-"));
	const prefix = join(temp, ".bun");
	const bunBin = join(prefix, "bin");
	const root = join(prefix, "install", "global", "node_modules");
	const scopeDir = join(root, "@earendil-works");
	const packageDir = join(scopeDir, "vsurf");
	mkdirSync(packageDir, { recursive: true });
	mkdirSync(bunBin, { recursive: true });
	writeFileSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), createFakeBunScript(bunBin));
	chmodSync(join(bunBin, process.platform === "win32" ? "bun.cmd" : "bun"), 0o755);
	tempDir = temp;
	process.env.PATH = `${bunBin}${delimiter}${originalPath ?? ""}`;
	process.env.VSURF_PACKAGE_DIR = packageDir;
	setExecPath(join(packageDir, "dist", "cli.js"));
	return { packageDir };
}

function createFakePnpmScript(root: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="root" if "%2"=="-g" echo ${root}\r\n`;
	}
	const escapedRoot = root.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "root" ] && [ "$2" = "-g" ]; then\n\tprintf '%s\\n' '${escapedRoot}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeYarnScript(globalDir: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="global" if "%2"=="dir" echo ${globalDir}\r\n`;
	}
	const escapedGlobalDir = globalDir.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "global" ] && [ "$2" = "dir" ]; then\n\tprintf '%s\\n' '${escapedGlobalDir}'\n\texit 0\nfi\nexit 1\n`;
}

function createFakeBunScript(bunBin: string): string {
	if (process.platform === "win32") {
		return `@echo off\r\nif "%1"=="pm" if "%2"=="bin" if "%3"=="-g" echo ${bunBin}\r\n`;
	}
	const escapedBunBin = bunBin.replaceAll("'", "'\\''");
	return `#!/bin/sh\nif [ "$1" = "pm" ] && [ "$2" = "bin" ] && [ "$3" = "-g" ]; then\n\tprintf '%s\\n' '${escapedBunBin}'\n\texit 0\nfi\nexit 1\n`;
}

describe("detectInstallMethod", () => {
	test("detects pnpm from Windows .pnpm install paths", () => {
		setExecPath(
			"C:\\Users\\Admin\\Documents\\pnpm-repository\\global\\5\\.pnpm\\@earendil-works+vsurf@0.67.68\\node_modules\\@earendil-works\\vsurf\\dist\\cli.js",
		);

		expect(detectInstallMethod()).toBe("pnpm");
		expect(getUpdateInstruction("vsurf")).toBe("Run: pnpm install -g vsurf");
	});

	test("does not self-update unknown wrapper installs", () => {
		setExecPath("/usr/local/bin/node");

		expect(detectInstallMethod()).toBe("unknown");
		expect(getSelfUpdateCommand("vsurf")).toBeUndefined();
		expect(getUpdateInstruction("vsurf")).toBe(
			"Update vsurf using the package manager, wrapper, or source checkout that provides this installation.",
		);
	});

	test("leaves Homebrew installs under Homebrew ownership", () => {
		createHomebrewInstall();

		expect(detectInstallMethod()).toBe("homebrew");
		expect(getSelfUpdateCommand("vsurf")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("vsurf")).toBe("Update with: brew upgrade vsurf");
		expect(getUpdateInstruction("vsurf")).toBe("Update with: brew upgrade vsurf");
	});

	test("self-updates npm installs from custom prefixes", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("vsurf");

		expect(detectInstallMethod()).toBe("npm");
		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "vsurf"],
			display: `npm --prefix ${prefix} install -g vsurf`,
		});
	});

	test("self-updates renamed packages from the current install prefix", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("@mariozechner/vsurf", undefined, "@new-scope/vsurf");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "@new-scope/vsurf"],
			display: `npm --prefix ${prefix} uninstall -g @mariozechner/vsurf && npm --prefix ${prefix} install -g @new-scope/vsurf`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "@mariozechner/vsurf"],
					display: `npm --prefix ${prefix} uninstall -g @mariozechner/vsurf`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", "@new-scope/vsurf"],
					display: `npm --prefix ${prefix} install -g @new-scope/vsurf`,
				},
			],
		});
	});

	test("self-updates tarball specs without uninstalling the same logical package first", () => {
		const { prefix } = createNpmPrefixInstall();
		const tarballUrl = "https://downloads.example.test/vsurf/vsurf-0.73.0.tgz";

		const command = getSelfUpdateCommand("vsurf", undefined, tarballUrl);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", tarballUrl],
			display: `npm --prefix ${prefix} install -g ${tarballUrl}`,
		});
	});

	test("self-updates renamed tarball packages by uninstalling the old package after install", () => {
		const { prefix } = createNpmPrefixInstall();
		const tarballUrl = "https://downloads.example.test/vsurf/vsurf-0.73.0.tgz";

		const command = getSelfUpdateCommand("vsurf", undefined, tarballUrl, "vsurf-cli");

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", tarballUrl],
			display: `npm --prefix ${prefix} install -g ${tarballUrl} && npm --prefix ${prefix} uninstall -g vsurf`,
			steps: [
				{
					command: "npm",
					args: ["--prefix", prefix, "install", "-g", tarballUrl],
					display: `npm --prefix ${prefix} install -g ${tarballUrl}`,
				},
				{
					command: "npm",
					args: ["--prefix", prefix, "uninstall", "-g", "vsurf"],
					display: `npm --prefix ${prefix} uninstall -g vsurf`,
				},
			],
		});
	});

	test("self-update respects configured npmCommand", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("vsurf", ["npm", "--prefix", prefix]);

		expect(command).toEqual({
			command: "npm",
			args: ["--prefix", prefix, "install", "-g", "vsurf"],
			display: `npm --prefix ${prefix} install -g vsurf`,
		});
	});

	test("self-update treats empty npmCommand as unset", () => {
		const { prefix } = createNpmPrefixInstall();

		const command = getSelfUpdateCommand("vsurf", []);

		expect(command?.args).toEqual(["--prefix", prefix, "install", "-g", "vsurf"]);
	});

	test("quotes npm self-update display paths", () => {
		const { prefix } = createNpmPrefixInstall("vsurf prefix ");

		const command = getSelfUpdateCommand("vsurf");

		expect(command?.display).toBe(`npm --prefix "${prefix}" install -g vsurf`);
	});

	test("does not infer Windows npm custom prefixes from package paths", () => {
		const packageDir = "C:\\Users\\Admin\\npm prefix\\node_modules\\@earendil-works\\vsurf";
		process.env.VSURF_PACKAGE_DIR = packageDir;
		setExecPath(`${packageDir}\\dist\\cli.js`);

		expect(detectInstallMethod()).toBe("npm");
		expect(getUpdateInstruction("vsurf")).toBe("Run: npm install -g vsurf");
	});

	test("self-updates bun global installs from bun pm bin", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("vsurf");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "vsurf"],
			display: "bun install -g vsurf",
		});
	});

	test("self-updates renamed pnpm global installs by removing the old package first", () => {
		createPnpmGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/vsurf", undefined, "@new-scope/vsurf");

		expect(detectInstallMethod()).toBe("pnpm");
		expect(command).toEqual({
			command: "pnpm",
			args: ["install", "-g", "@new-scope/vsurf"],
			display: "pnpm remove -g @mariozechner/vsurf && pnpm install -g @new-scope/vsurf",
			steps: [
				{
					command: "pnpm",
					args: ["remove", "-g", "@mariozechner/vsurf"],
					display: "pnpm remove -g @mariozechner/vsurf",
				},
				{
					command: "pnpm",
					args: ["install", "-g", "@new-scope/vsurf"],
					display: "pnpm install -g @new-scope/vsurf",
				},
			],
		});
	});

	test("self-updates renamed yarn global installs by removing the old package first", () => {
		createYarnGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/vsurf", undefined, "@new-scope/vsurf");

		expect(detectInstallMethod()).toBe("yarn");
		expect(command).toEqual({
			command: "yarn",
			args: ["global", "add", "@new-scope/vsurf"],
			display: "yarn global remove @mariozechner/vsurf && yarn global add @new-scope/vsurf",
			steps: [
				{
					command: "yarn",
					args: ["global", "remove", "@mariozechner/vsurf"],
					display: "yarn global remove @mariozechner/vsurf",
				},
				{
					command: "yarn",
					args: ["global", "add", "@new-scope/vsurf"],
					display: "yarn global add @new-scope/vsurf",
				},
			],
		});
	});

	test("self-updates renamed bun global installs by removing the old package first", () => {
		createBunGlobalInstall();

		const command = getSelfUpdateCommand("@mariozechner/vsurf", undefined, "@new-scope/vsurf");

		expect(detectInstallMethod()).toBe("bun");
		expect(command).toEqual({
			command: "bun",
			args: ["install", "-g", "@new-scope/vsurf"],
			display: "bun uninstall -g @mariozechner/vsurf && bun install -g @new-scope/vsurf",
			steps: [
				{
					command: "bun",
					args: ["uninstall", "-g", "@mariozechner/vsurf"],
					display: "bun uninstall -g @mariozechner/vsurf",
				},
				{
					command: "bun",
					args: ["install", "-g", "@new-scope/vsurf"],
					display: "bun install -g @new-scope/vsurf",
				},
			],
		});
	});

	test("does not self-update when npm install path is not writable", () => {
		const { packageDir } = createNpmPrefixInstall();
		chmodSync(packageDir, 0o500);

		expect(getSelfUpdateCommand("vsurf")).toBeUndefined();
		expect(getSelfUpdateUnavailableInstruction("vsurf")).toContain("the install path is not writable");
	});
});

describe("session paths", () => {
	test("uses the short app-prefixed session dir env var", () => {
		expect(ENV_SESSION_DIR).toBe("VSURF_SESSION_DIR");
	});

	test("uses the session root env var when computing sessions dir", () => {
		const sessionRoot = join(tmpdir(), `vsurf-session-root-${Date.now()}`);
		process.env[ENV_SESSION_DIR] = sessionRoot;

		expect(getSessionsDir("/agent")).toBe(sessionRoot);
	});

	test("uses the legacy coding agent session root env var when the new env var is unset", () => {
		const sessionRoot = join(tmpdir(), `vsurf-legacy-session-root-${Date.now()}`);
		delete process.env[ENV_SESSION_DIR];
		process.env[ENV_LEGACY_SESSION_DIR] = sessionRoot;

		expect(getSessionsDir("/agent")).toBe(sessionRoot);
	});

	test("expands tilde in the session root env var", () => {
		process.env[ENV_SESSION_DIR] = "~/vsurf-sessions";

		expect(getSessionsDir("/agent")).toBe(join(homedir(), "vsurf-sessions"));
	});

	test("uses the env session root as the default session dir", () => {
		tempDir = mkdtempSync(join(tmpdir(), "vsurf-session-root-"));
		const cwd = join(tempDir, "project");
		const sessionRoot = join(tempDir, "sessions-root");
		process.env[ENV_SESSION_DIR] = sessionRoot;

		const sessionDir = getDefaultSessionDir(cwd, join(tempDir, "agent"));

		expect(sessionDir).toBe(sessionRoot);
	});
});
