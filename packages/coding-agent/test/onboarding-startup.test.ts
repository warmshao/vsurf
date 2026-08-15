import { describe, expect, test } from "vitest";
import type { Api, Model } from "vsurf-ai";
import { type OnboardingStartupState, shouldRunOnboarding } from "../src/modes/interactive/onboarding.js";

function makeModel(provider: string): Model<Api> {
	return { id: "test-model", provider } as Model<Api>;
}

function makeState(overrides: {
	onboardingShown: boolean;
	model: Model<Api> | undefined;
	modelHasAuth?: boolean;
}): OnboardingStartupState {
	return {
		settingsManager: {
			getOnboardingShown: () => overrides.onboardingShown,
		},
		modelRegistry: {
			refresh: () => {},
			hasConfiguredAuth: () => overrides.modelHasAuth ?? false,
			getProviderAuthStatus: () => ({ configured: false }),
		},
		model: overrides.model,
	};
}

describe("startup onboarding decision", () => {
	test("runs onboarding on first launch when no model is available", () => {
		expect(shouldRunOnboarding(makeState({ onboardingShown: false, model: undefined }))).toBe(true);
	});

	test("runs onboarding when the current model has no configured auth", () => {
		expect(
			shouldRunOnboarding(makeState({ onboardingShown: false, model: makeModel("anthropic"), modelHasAuth: false })),
		).toBe(true);
	});

	test("reopens the configuration flow after dismissal when no model is available", () => {
		expect(shouldRunOnboarding(makeState({ onboardingShown: true, model: undefined }))).toBe(true);
	});

	test("reopens the configuration flow after dismissal when the current model has no auth", () => {
		expect(
			shouldRunOnboarding(makeState({ onboardingShown: true, model: makeModel("anthropic"), modelHasAuth: false })),
		).toBe(true);
	});

	test("skips onboarding once a model is ready", () => {
		expect(
			shouldRunOnboarding(makeState({ onboardingShown: true, model: makeModel("anthropic"), modelHasAuth: true })),
		).toBe(false);
	});

	test("skips onboarding on first launch when a model is already ready", () => {
		expect(
			shouldRunOnboarding(makeState({ onboardingShown: false, model: makeModel("anthropic"), modelHasAuth: true })),
		).toBe(false);
	});
});
