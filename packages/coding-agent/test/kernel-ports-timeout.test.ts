import { afterEach, describe, expect, it } from "vitest";
import { resolvePortsResolveTimeoutMs } from "../src/core/kernel/index.js";

const ENV = "VSURF_KERNEL_PORTS_TIMEOUT_MS";

describe("resolvePortsResolveTimeoutMs", () => {
	afterEach(() => {
		delete process.env[ENV];
	});

	it("uses the platform default when the env var is unset or malformed", () => {
		const expected = process.platform === "win32" ? 15000 : 5000;
		expect(resolvePortsResolveTimeoutMs()).toBe(expected);
		for (const bad of ["0", "00", "abc", "3.9", "-1", "8 junk", ""]) {
			process.env[ENV] = bad;
			expect(resolvePortsResolveTimeoutMs()).toBe(expected);
		}
	});

	it("honors a clean positive integer, clamped to the max", () => {
		process.env[ENV] = "30000";
		expect(resolvePortsResolveTimeoutMs()).toBe(30000);
		process.env[ENV] = "999999";
		expect(resolvePortsResolveTimeoutMs()).toBe(120000);
	});
});
