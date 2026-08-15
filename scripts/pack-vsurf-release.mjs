#!/usr/bin/env node

// Packs the release for the npm registry: internal dependencies are pinned to
// the exact release version and the staged packages under <out-dir>/packages/*
// are published in dependency order: ai, tui, agent, coding-agent.

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
const publicCommandName = process.env.VSURF_CMD || "vsurf";

const releasePackages = [
	{ packageDir: "ai" },
	{ packageDir: "tui" },
	{ packageDir: "agent" },
	{ packageDir: "coding-agent" },
];

// The unscoped "vsurf" name is blocked on npm (too similar to the existing
// "csurf" package), so the CLI is published under the owner's scope. The
// installed command is still "vsurf".
function publicPackageName() {
	return process.env.VSURF_PACKAGE_NAME || "@warmshao/vsurf";
}

function parseArgs(args) {
	const parsed = {
		outDir: defaultOutputDir,
		version: undefined,
	};

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		switch (arg) {
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

	return parsed;
}

function printHelp() {
	console.log(`Usage: node scripts/pack-vsurf-release.mjs [--version x.y.z] [--out-dir path]

Stages the release packages for npm publishing:

  <out-dir>/packages/{ai,tui,agent,coding-agent}  staged package directories
  <out-dir>/artifacts/*.tgz                        npm pack tarballs
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

function pinInternalDependencies(dependencies, internalPackageVersions) {
	if (!dependencies) return undefined;
	const rewritten = {};
	for (const [name, range] of Object.entries(dependencies)) {
		rewritten[name] = internalPackageVersions.get(name) || range;
	}
	return rewritten;
}

function releaseScripts(sourceScripts) {
	if (!sourceScripts?.postinstall) return undefined;
	return {
		postinstall: sourceScripts.postinstall,
	};
}

function createReleasePackageJson(sourcePackage, packageName, releaseVersion, internalPackageVersions, isPublicCli) {
	const packageJson = {
		...sourcePackage,
		name: packageName,
		version: releaseVersion,
		dependencies: pinInternalDependencies(sourcePackage.dependencies, internalPackageVersions),
		optionalDependencies: pinInternalDependencies(sourcePackage.optionalDependencies, internalPackageVersions),
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
	const cliPublicName = publicPackageName();

	for (const releasePackage of releasePackages) {
		requireBuiltPackage(releasePackage.packageDir);
	}

	// Internal packages keep their source names so dependency keys match the
	// published packages; only the CLI is renamed to the public scoped name.
	const packageNames = new Map();
	const artifactFiles = new Map();
	for (const releasePackage of releasePackages) {
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		const packageName = releasePackage.packageDir === "coding-agent" ? cliPublicName : sourcePackage.name;
		packageNames.set(releasePackage.packageDir, packageName);
		artifactFiles.set(releasePackage.packageDir, npmTarballName(packageName, releaseVersion));
	}

	const internalPackageVersions = new Map();
	for (const releasePackage of releasePackages) {
		if (releasePackage.packageDir === "coding-agent") continue;
		const sourcePackage = sourcePackages.get(releasePackage.packageDir);
		internalPackageVersions.set(sourcePackage.name, releaseVersion);
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
			internalPackageVersions,
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
	for (const tarball of tarballs) {
		console.log(`Staged ${tarball.name}@${releaseVersion} (${join(artifactsDir, tarball.file)})`);
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
