#!/usr/bin/env node

// Packs the release in one of two modes:
// - r2 (default): internal dependencies are rewritten to tarball URLs hosted on
//   R2, consumed by install.sh via `npm install -g <tarball>`.
// - npm: internal dependencies are pinned to the exact release version and the
//   staged packages are published to the npm registry (npm install -g vsurf).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	renameSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutputDir = join(root, "packages", "coding-agent", "release");
const defaultBaseUrl = process.env.VSURF_DOWNLOAD_BASE_URL;
const publicCommandName = process.env.VSURF_CMD || "vsurf";
const releaseChannels = new Set(["stable", "beta"]);
const registries = new Set(["r2", "npm"]);

const releasePackages = [
	{ packageDir: "ai", artifactName: "vsurf-ai" },
	{ packageDir: "tui", artifactName: "vsurf-tui" },
	{ packageDir: "agent", artifactName: "vsurf-core" },
	{ packageDir: "coding-agent", artifactName: "vsurf" },
];

// The unscoped "vsurf" name is blocked on npm (too similar to the existing
// "csurf" package), so npm releases publish the CLI under the owner's scope.
// The installed command is still "vsurf".
function publicPackageName(registry) {
	return process.env.VSURF_PACKAGE_NAME || (registry === "npm" ? "@warmshao/vsurf" : "vsurf");
}

function parseArgs(args) {
	const parsed = {
		baseUrl: defaultBaseUrl,
		channel: "stable",
		outDir: defaultOutputDir,
		registry: "r2",
		version: undefined,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
			case "--registry": {
				const value = args[i + 1];
				if (!value || !registries.has(value)) {
					throw new Error("--registry must be r2 or npm");
				}
				parsed.registry = value;
				i += 1;
				break;
			}
			case "--channel": {
				const value = args[i + 1];
				if (!value || !releaseChannels.has(value)) {
					throw new Error("--channel must be stable or beta");
				}
				parsed.channel = value;
				i += 1;
				break;
			}
			case "--base-url": {
				const value = args[i + 1];
				if (!value) throw new Error("--base-url requires a value");
				parsed.baseUrl = value;
				i += 1;
				break;
			}
			case "--out-dir": {
				const value = args[i + 1];
				if (!value) throw new Error("--out-dir requires a value");
				parsed.outDir = resolve(root, value);
				i += 1;
				break;
			}
			case "--version": {
				const value = args[i + 1];
				if (!value) throw new Error("--version requires a value");
				parsed.version = normalizeVersion(value);
				i += 1;
				break;
			}
			case "--help":
			case "-h":
				printHelp();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (parsed.registry === "r2" && !parsed.baseUrl) {
		throw new Error("--base-url or VSURF_DOWNLOAD_BASE_URL is required for the r2 registry");
	}

	if (parsed.baseUrl) {
		parsed.baseUrl = parsed.baseUrl.replace(/\/+$/, "");
	}
	return parsed;
}

function printHelp() {
	console.log(`Usage: node scripts/pack-vsurf-release.mjs [--registry r2|npm] [--base-url url] [--channel stable|beta] [--version x.y.z] [--out-dir path]

Creates private npm tarballs for R2 distribution (default):

  <out-dir>/artifacts/vsurf-<version>.tgz
  <out-dir>/artifacts/vsurf-ai-<version>.tgz
  <out-dir>/artifacts/vsurf-agent-<version>.tgz
  <out-dir>/artifacts/vsurf-tui-<version>.tgz
  <out-dir>/artifacts/SHA256SUMS
  <out-dir>/artifacts/<channel>
  <out-dir>/artifacts/latest.json (stable) or beta.json (beta)

With --registry npm, internal dependencies are pinned to the exact release
version and the staged packages under <out-dir>/packages/* are published to
the npm registry in dependency order: ai, tui, agent, coding-agent.
`);
}

function normalizeVersion(version) {
	const normalized = version.startsWith("v") ? version.slice(1) : version;
	if (!/^[0-9A-Za-z.-]+$/.test(normalized)) {
		throw new Error(`Invalid release version: ${version}`);
	}
	return normalized;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packagePath(packageDir) {
	return join(root, "packages", packageDir);
}

function assertSafeOutputDir(outDir) {
	const relativeToReleaseRoot = relative(defaultOutputDir, outDir);
	if (relativeToReleaseRoot === "" || (!relativeToReleaseRoot.startsWith("..") && !isAbsolute(relativeToReleaseRoot))) {
		return;
	}
	throw new Error(`Refusing to remove output directory outside ${defaultOutputDir}: ${outDir}`);
}

function packageJsonPath(packageDir) {
	return join(packagePath(packageDir), "package.json");
}

function requireBuiltPackage(packageDir) {
	const dist = join(packagePath(packageDir), "dist");
	if (!existsSync(dist)) {
		throw new Error(`Missing ${dist}. Run npm run build before packing a release.`);
	}
}

function copyIfExists(source, target) {
	if (existsSync(source)) {
		cpSync(source, target, { recursive: true });
	}
}

function npmTarballName(packageName, version) {
	return `${packageName.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

function releaseTarballUrl(baseUrl, version, tarballFile) {
	return `${baseUrl}/releases/v${version}/${tarballFile}`;
}

function rewriteInternalDependencies(dependencies, internalPackageRefs) {
	if (!dependencies) return undefined;
	const rewritten = {};
	for (const [name, range] of Object.entries(dependencies)) {
		rewritten[name] = internalPackageRefs.get(name) || range;
	}
	return rewritten;
}

function releaseScripts(sourceScripts) {
	if (!sourceScripts?.postinstall) return undefined;
	return {
		postinstall: sourceScripts.postinstall,
	};
}

function createReleasePackageJson(sourcePackage, packageName, releaseVersion, internalPackageRefs, isPublicCli) {
	const packageJson = {
		...sourcePackage,
		name: packageName,
		version: releaseVersion,
		dependencies: rewriteInternalDependencies(sourcePackage.dependencies, internalPackageRefs),
		optionalDependencies: rewriteInternalDependencies(sourcePackage.optionalDependencies, internalPackageRefs),
		scripts: releaseScripts(sourcePackage.scripts),
	};

	delete packageJson.devDependencies;
	delete packageJson.overrides;
	delete packageJson.private;

	if (isPublicCli) {
		packageJson.bin = {
			[publicCommandName]: "dist/bundle/cli.js",
		};
		packageJson.vsurfConfig = {
			...(packageJson.vsurfConfig || {}),
			name: publicCommandName,
			configDir: ".vsurf/agent",
		};
	}

	return packageJson;
}

function copyPackageContents(sourceDir, targetDir, packageJson) {
	mkdirSync(targetDir, { recursive: true });
	writeJson(join(targetDir, "package.json"), packageJson);

	for (const entry of ["dist", "docs", "examples", "skills", "postinstall.cjs", "README.md", "CHANGELOG.md"]) {
		copyIfExists(join(sourceDir, entry), join(targetDir, entry));
	}
}

function run(command, args, cwd, { shell = false } = {}) {
	const result = spawnSync(command, args, {
		cwd,
		shell,
		stdio: "pipe",
		encoding: "utf8",
	});

	if (result.error) {
		throw new Error(`${command} ${args.join(" ")} failed to start: ${result.error.message}`);
	}

	if (result.status !== 0) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
	}

	if (result.stderr) process.stderr.write(result.stderr);
	return result.stdout.trim();
}

function sha256File(path) {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const sourcePackages = new Map(
		releasePackages.map((releasePackage) => [
			releasePackage.packageDir,
			readJson(packageJsonPath(releasePackage.packageDir)),
		]),
	);
	const cliPackage = sourcePackages.get("coding-agent");
	const releaseVersion = args.version || normalizeVersion(process.env.VSURF_VERSION || cliPackage.version);
	const cliPublicName = publicPackageName(args.registry);

	for (const releasePackage of releasePackages) {
		requireBuiltPackage(releasePackage.packageDir);
	}

	// Dependency keys stay on the source package names so existing compiled imports
	// keep resolving. In r2 mode the release values are branded tarball URLs; in npm
	// mode they are the exact release version and packages keep their source names
	// so registry resolution works.
	const sourcePackageNames = new Map();
	const packageNames = new Map();
	const artifactFiles = new Map();
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName =
			releasePackage.packageDir === "coding-agent"
				? cliPublicName
				: args.registry === "npm"
					? sourcePackage.name
					: releasePackage.artifactName || sourcePackage.name;
		sourcePackageNames.set(releasePackage.packageDir, sourcePackage.name);
		packageNames.set(releasePackage.packageDir, packageName);
		artifactFiles.set(
			releasePackage.packageDir,
			npmTarballName(
				args.registry === "npm" ? packageName : releasePackage.artifactName || packageName,
				releaseVersion,
			),
		);
	}

	const internalPackageRefs = new Map();
	for (const releasePackage of releasePackages) {
		if (releasePackage.packageDir === "coding-agent") continue;
		const sourcePackageName = sourcePackageNames.get(releasePackage.packageDir);
		const artifactFile = artifactFiles.get(releasePackage.packageDir);
		internalPackageRefs.set(
			sourcePackageName,
			args.registry === "npm" ? releaseVersion : releaseTarballUrl(args.baseUrl, releaseVersion, artifactFile),
		);
	}

	const stagingRoot = join(args.outDir, "packages");
	const artifactsDir = join(args.outDir, "artifacts");
	assertSafeOutputDir(args.outDir);
	rmSync(args.outDir, { force: true, recursive: true });
	mkdirSync(stagingRoot, { recursive: true });
	mkdirSync(artifactsDir, { recursive: true });

	const tarballs = [];
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName = packageNames.get(releasePackage.packageDir);
		const stagingDir = join(stagingRoot, releasePackage.packageDir);
		const packageJson = createReleasePackageJson(
			sourcePackage,
			packageName,
			releaseVersion,
			internalPackageRefs,
			releasePackage.packageDir === "coding-agent",
		);

		copyPackageContents(packagePath(releasePackage.packageDir), stagingDir, packageJson);

		// Windows blocks spawning .cmd shims without a shell (CVE-2024-27980).
		const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
		const tarballName = run(
			npmCommand,
			["pack", stagingDir, "--pack-destination", artifactsDir, "--silent"],
			root,
			{ shell: process.platform === "win32" },
		)
			.split("\n")
			.at(-1);
		if (!tarballName) {
			throw new Error(`npm pack did not report a tarball name for ${packageName}`);
		}

		const tarballPath = join(artifactsDir, basename(tarballName));
		if (!existsSync(tarballPath) || !statSync(tarballPath).isFile()) {
			throw new Error(`npm pack did not create ${tarballPath}`);
		}

		const artifactFile = artifactFiles.get(releasePackage.packageDir);
		const artifactPath = join(artifactsDir, artifactFile);
		if (tarballPath !== artifactPath) {
			rmSync(artifactPath, { force: true });
			renameSync(tarballPath, artifactPath);
		}

		tarballs.push({
			name: packageName,
			file: artifactFile,
			sha256: sha256File(artifactPath),
		});
	}

	tarballs.sort((left, right) => left.file.localeCompare(right.file));
	if (args.registry === "npm") {
		for (const tarball of tarballs) {
			console.log(`Staged ${tarball.name}@${releaseVersion} (${join(artifactsDir, tarball.file)})`);
		}
		return;
	}

	writeFileSync(
		join(artifactsDir, "SHA256SUMS"),
		tarballs.map((tarball) => `${tarball.sha256}  ${tarball.file}`).join("\n") + "\n",
	);
	writeFileSync(join(artifactsDir, args.channel), `v${releaseVersion}\n`);
	const manifestName = args.channel === "stable" ? "latest.json" : "beta.json";
	writeJson(join(artifactsDir, manifestName), {
		version: `v${releaseVersion}`,
		package: cliPublicName,
		tarball: `releases/v${releaseVersion}/${artifactFiles.get("coding-agent")}`,
		tarballs: tarballs.map((tarball) => ({
			package: tarball.name,
			file: tarball.file,
			sha256: tarball.sha256,
		})),
	});

	for (const tarball of tarballs) {
		console.log(`Created ${join(artifactsDir, tarball.file)}`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
