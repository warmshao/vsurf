import { afterEach, describe, expect, it } from "vitest";
import { resolveKernelBootConcurrency } from "../src/core/kernel/boot-gate.js";

const ENV = "VSURF_MAX_CONCURRENT_KERNEL_BOOTS";
const FORK_ENV = "VSURF_KERNEL_FORKSERVER";

describe("resolveKernelBootConcurrency", () => {
	afterEach(() => {
		delete process.env[ENV];
		delete process.env[FORK_ENV];
	});

	it("never returns a value below 1 (so the semaphore can't throw at load)", () => {
		for (const bad of ["0", "00", "000", "abc", "3.9", "-1", "8 junk", ""]) {
			process.env[ENV] = bad;
			expect(resolveKernelBootConcurrency()).toBeGreaterThanOrEqual(1);
		}
	});

	it("honors a clean positive integer, clamped to the direct-spawn max", () => {
		process.env[FORK_ENV] = "0"; // direct-spawn path (forkserver is default-on)
		process.env[ENV] = "8";
		expect(resolveKernelBootConcurrency()).toBe(8);
		process.env[ENV] = "999999";
		expect(resolveKernelBootConcurrency()).toBe(64);
	});

	it("raises the ceiling on the forkserver path (linux, default on)", () => {
		if (process.platform !== "linux") return;
		const auto = resolveKernelBootConcurrency();
		expect(auto).toBeGreaterThanOrEqual(32);
		expect(auto).toBeLessThanOrEqual(128);
		process.env[ENV] = "999999";
		expect(resolveKernelBootConcurrency()).toBe(128);
	});
});
