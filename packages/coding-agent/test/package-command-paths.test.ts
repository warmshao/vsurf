import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APP_NAME, ENV_AGENT_DIR, PACKAGE_NAME, SELF_UPDATE_INTERACTIVE_CHILD_ENV, VERSION } from "../src/config.js";
import { main } from "../src/main.js";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

async function runSelfUpdateInstallChild(args: string[]): Promise<void> {
	const previousValue = process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV];
	process.env[SELF_UPDATE_INTERACTIVE_CHILD_ENV] = "1";
	try {
		await main(args);
	} finally {
		restoreEnv(SELF_UPDATE_INTERACTIVE_CHILD_ENV, previousValue);
	}
}

describe("package commands", () => {
	let tempDir: string;
	let agentDir: string;
	let projectDir: string;
	let packageDir: string;
	let originalCwd: string;
	let originalAgentDir: string | undefined;
	let originalPiPackageDir: string | undefined;
	let originalTmpDir: string | undefined;
	let originalExitCode: typeof process.exitCode;
	let originalExecPath: string;

	function getNewerPatchVersion(): string {
		const [major = "0", minor = "0", patch = "0"] = VERSION.split(".");
		return `${major}.${minor}.${Number.parseInt(patch, 10) + 1}`;
	}

	beforeEach(() => {
		tempDir = join(tmpdir(), `vsurf-package-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		projectDir = join(tempDir, "project");
		packageDir = join(tempDir, "local-package");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(packageDir, { recursive: true });

		originalCwd = process.cwd();
		originalAgentDir = process.env[ENV_AGENT_DIR];
		originalPiPackageDir = process.env.VSURF_PACKAGE_DIR;
		originalTmpDir = process.env.TMPDIR;
		originalExitCode = process.exitCode;
		originalExecPath = process.execPath;
		process.exitCode = undefined;
		process.env[ENV_AGENT_DIR] = agentDir;
		process.env.TMPDIR = tempDir;
		process.chdir(projectDir);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		process.exitCode = originalExitCode;
		restoreEnv(ENV_AGENT_DIR, originalAgentDir);
		restoreEnv("VSURF_PACKAGE_DIR", originalPiPackageDir);
		restoreEnv("TMPDIR", originalTmpDir);
		Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true });
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("should persist global relative local package paths relative to settings.json", async () => {
		const relativePkgDir = join(projectDir, "packages", "local-package");
		mkdirSync(relativePkgDir, { recursive: true });

		await main(["package", "install", "./packages/local-package"]);

		const settingsPath = join(agentDir, "settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(settings.packages?.length).toBe(1);
		const stored = settings.packages?.[0] ?? "";
		const resolvedFromSettings = realpathSync(join(agentDir, stored));
		expect(resolvedFromSettings).toBe(realpathSync(relativePkgDir));
	});

	it("should remove local packages using a path with a trailing slash", async () => {
		await main(["package", "install", `${packageDir}/`]);

		const settingsPath = join(agentDir, "settings.json");
		const installedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(installedSettings.packages?.length).toBe(1);

		await main(["package", "remove", `${packageDir}/`]);

		const removedSettings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
		expect(removedSettings.packages ?? []).toHaveLength(0);
	});

	it("shows install subcommand help", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", "--help"])).resolves.toBeUndefined();

			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).toContain("Usage:");
			expect(stdout).toContain(`${APP_NAME} package install <source> [--local]`);
			expect(errorSpy).not.toHaveBeenCalled();
			expect(process.exitCode).toBeUndefined();
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for unknown install options", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", "--unknown"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option --unknown for "install".');
			expect(stderr).toContain(`Use "${APP_NAME} --help" or "${APP_NAME} package install <source> [--local]".`);
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("directs the removed -l package option to --local", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install", packageDir, "-l"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Option -l was removed. Use "--local".');
			expect(process.exitCode).toBe(1);
			expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("treats -l as an unknown option for package update", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "update", "-l"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain('Unknown option -l for "update".');
			expect(stderr).not.toContain('Use "--local".');
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("shows a friendly error for missing install source", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["package", "install"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Missing install source.");
			expect(stderr).toContain(`Usage: ${APP_NAME} package install <source> [--local]`);
			expect(stderr).not.toContain("at ");
			expect(process.exitCode).toBe(1);
		} finally {
			errorSpy.mockRestore();
		}
	});

	it("uses global npmCommand and the dist-tag install spec for forced self updates", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const projectPrefix = join(tempDir, "project-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@earendil-works", "vsurf");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		mkdirSync(join(projectDir, ".vsurf", "agent"), { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else if(args.includes("view")) console.log("${getNewerPatchVersion()}");
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		writeFileSync(
			join(projectDir, ".vsurf", "agent", "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", projectPrefix] }, null, 2),
		);
		process.env.VSURF_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runSelfUpdateInstallChild(["update", "--self", "--force"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			const recordedArgs = JSON.parse(readFileSync(recordPath, "utf-8")) as string[];
			expect(recordedArgs).toContain(globalPrefix);
			expect(recordedArgs).toContain(`${PACKAGE_NAME}@latest`);
			expect(recordedArgs).not.toContain(projectPrefix);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("installs the dist-tag spec for the current package during self-update", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "vsurf");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else if(args.includes("view")) console.log("${getNewerPatchVersion()}");
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.VSURF_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			const recordedArgs = JSON.parse(readFileSync(recordPath, "utf-8")) as string[];
			expect(recordedArgs).toContain(`${PACKAGE_NAME}@latest`);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("installs the dist-tag spec without uninstalling the current package", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "vsurf");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else if(args.includes("view")) console.log("0.73.0");
else {
	const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
	records.push(args);
	fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
}
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.VSURF_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(runSelfUpdateInstallChild(["update", "--self"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([expect.arrayContaining(["install", "-g", `${PACKAGE_NAME}@latest`])]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("does not self-update when the dist-tag already matches the current version", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@earendil-works", "vsurf");
		const fakeNpmPath = join(tempDir, "fake-npm.cjs");
		const recordPath = join(tempDir, "self-update.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) console.log(path.join(prefix,"lib","node_modules"));
else if(args.includes("view")) console.log(${JSON.stringify(VERSION)});
else fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(args));
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.VSURF_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update"])).resolves.toBeUndefined();

			expect(process.exitCode).toBeUndefined();
			expect(errorSpy).not.toHaveBeenCalled();
			expect(logSpy.mock.calls.map(([message]) => String(message)).join("\n")).toContain("is already up to date");
			expect(existsSync(recordPath)).toBe(false);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("fails self-update when the npm install fails", async () => {
		const globalPrefix = join(tempDir, "global-prefix");
		const selfPackageDir = join(globalPrefix, "lib", "node_modules", "@mariozechner", "vsurf");
		const fakeNpmPath = join(tempDir, "fake-npm-fail.cjs");
		const recordPath = join(tempDir, "self-update-fail.json");
		mkdirSync(selfPackageDir, { recursive: true });
		writeFileSync(
			fakeNpmPath,
			`const fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),prefix=args[args.indexOf("--prefix")+1];
if(args.includes("root")) {
	console.log(path.join(prefix,"lib","node_modules"));
	process.exit(0);
}
if(args.includes("view")) {
	console.log("0.73.0");
	process.exit(0);
}
const records=fs.existsSync(${JSON.stringify(recordPath)})?JSON.parse(fs.readFileSync(${JSON.stringify(recordPath)},"utf-8")):[];
records.push(args);
fs.writeFileSync(${JSON.stringify(recordPath)},JSON.stringify(records));
if(args.includes("install")) process.exit(23);
`,
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ npmCommand: [originalExecPath, fakeNpmPath, "--prefix", globalPrefix] }, null, 2),
		);
		process.env.VSURF_PACKAGE_DIR = selfPackageDir;
		Object.defineProperty(process, "execPath", {
			value: join(selfPackageDir, "dist", "cli.js"),
			configurable: true,
		});

		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			await expect(main(["update"])).resolves.toBeUndefined();

			expect(process.exitCode).toBe(1);
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stdout).not.toContain(`Updated vsurf`);
			expect(stderr).toContain("exited with code 23");
			const recordedCalls = JSON.parse(readFileSync(recordPath, "utf-8")) as string[][];
			expect(recordedCalls).toEqual([expect.arrayContaining(["install", "-g", `${PACKAGE_NAME}@latest`])]);
		} finally {
			logSpy.mockRestore();
			errorSpy.mockRestore();
		}
	});

	it("suggests the configured source when update input omits the npm prefix", async () => {
		const settingsPath = join(agentDir, "settings.json");
		writeFileSync(settingsPath, JSON.stringify({ packages: ["npm:vsurf-formatter"] }, null, 2));

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		try {
			await expect(main(["package", "update", "vsurf-formatter"])).resolves.toBeUndefined();

			const stderr = errorSpy.mock.calls.map(([message]) => String(message)).join("\n");
			const stdout = logSpy.mock.calls.map(([message]) => String(message)).join("\n");
			expect(stderr).toContain("Did you mean npm:vsurf-formatter?");
			expect(stdout).not.toContain("Updated vsurf-formatter");
			expect(process.exitCode).toBe(1);

			const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as { packages?: string[] };
			expect(settings.packages).toContain("npm:vsurf-formatter");
		} finally {
			errorSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});
