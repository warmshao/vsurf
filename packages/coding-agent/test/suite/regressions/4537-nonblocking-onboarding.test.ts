import { afterEach, describe, expect, test } from "vitest";
import { shouldRunOnboarding } from "../../../src/modes/interactive/onboarding.js";
import { createHarness, type Harness } from "../harness.js";

describe("ENG-4537 non-blocking onboarding", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) {
			harness.cleanup();
		}
	});

	test("reopens onboarding when no configured auth matches the current model", async () => {
		const harness = await createHarness({
			settings: { onboardingShown: true },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		expect(
			shouldRunOnboarding({
				settingsManager: harness.settingsManager,
				modelRegistry: harness.session.modelRegistry,
				model: harness.session.model,
			}),
		).toBe(true);
	});

	test("reopens onboarding when the daemon session has no model", async () => {
		const harness = await createHarness({
			settings: { onboardingShown: true },
			withConfiguredAuth: false,
		});
		harnesses.push(harness);

		expect(
			shouldRunOnboarding({
				settingsManager: harness.settingsManager,
				modelRegistry: harness.session.modelRegistry,
				model: undefined,
			}),
		).toBe(true);
	});
});
