import { afterEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	getLatestPiRelease,
	getLatestPiVersion,
	isBetaPackageVersion,
	isNewerPackageVersion,
} from "../src/utils/version-check.js";

const defaultNpmRegistryUrl = "https://registry.npmjs.org";
const packageName = "@warmshao/vsurf";
const originalSkipVersionCheck = process.env.VSURF_SKIP_VERSION_CHECK;
const originalOffline = process.env.VSURF_OFFLINE;
const originalNpmRegistryUrl = process.env.VSURF_NPM_REGISTRY_URL;

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}
	process.env[name] = value;
}

function packumentResponse(distTags: Record<string, string>): Response {
	return Response.json({ "dist-tags": distTags });
}

afterEach(() => {
	vi.unstubAllGlobals();
	restoreEnv("VSURF_SKIP_VERSION_CHECK", originalSkipVersionCheck);
	restoreEnv("VSURF_OFFLINE", originalOffline);
	restoreEnv("VSURF_NPM_REGISTRY_URL", originalNpmRegistryUrl);
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("0.70.5-beta.10.1.abcdef0", "0.70.5-beta.9.1.1234567")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("detects beta package versions", () => {
		expect(isBetaPackageVersion("1.2.4-beta.123.1.1234567")).toBe(true);
		expect(isBetaPackageVersion("1.2.4-beta")).toBe(true);
		expect(isBetaPackageVersion("1.2.4")).toBe(false);
		expect(isBetaPackageVersion("1.2.4-rc.1")).toBe(false);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => packumentResponse({ latest: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion(packageName, "1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion(packageName, "1.2.2")).resolves.toBe("1.2.3");
	});

	it("reads the latest dist-tag from the npm packument with a VSurf user agent", async () => {
		const fetchMock = vi.fn(async () => packumentResponse({ latest: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion(packageName, "1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			`${defaultNpmRegistryUrl}/@warmshao%2fvsurf`,
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^vsurf\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("keeps beta installations on the beta dist-tag", async () => {
		const fetchMock = vi.fn(async () => packumentResponse({ latest: "1.2.4", beta: "1.2.4-beta.124.1.abcdef0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion(packageName, "1.2.4-beta.123.1.1234567")).resolves.toBe(
			"1.2.4-beta.124.1.abcdef0",
		);
	});

	it("returns the dist-tag install spec from the packument", async () => {
		const fetchMock = vi.fn(async () => packumentResponse({ latest: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease(packageName, "1.2.3")).resolves.toEqual({
			installSpec: "@warmshao/vsurf@latest",
			packageName: "@warmshao/vsurf",
			version: "1.2.4",
		});
	});

	it("skips api calls when version checks are disabled", async () => {
		process.env.VSURF_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion(packageName, "1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
