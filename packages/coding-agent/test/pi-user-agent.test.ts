import { describe, expect, it } from "vitest";
import { getPiUserAgent } from "../src/utils/vsurf-user-agent.js";

describe("getPiUserAgent", () => {
	it("formats the VSurf user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getPiUserAgent("1.2.3");

		expect(userAgent).toBe(`vsurf/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^vsurf\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
