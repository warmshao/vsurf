import type { Api, Model } from "vsurf-ai";
import type { AuthStatus } from "../../core/auth-storage.js";

export interface OnboardingSettingsReader {
	getOnboardingShown(): boolean;
}

export interface OnboardingModelRegistryReader {
	refresh(): void;
	hasConfiguredAuth(model: Model<Api>): boolean;
	getProviderAuthStatus(provider: string): AuthStatus;
}

export interface OnboardingStartupState {
	settingsManager: OnboardingSettingsReader;
	modelRegistry: OnboardingModelRegistryReader;
	model: Model<Api> | undefined;
}

export function isOnboardingModelReady(state: OnboardingStartupState): boolean {
	return state.model !== undefined && state.modelRegistry.hasConfiguredAuth(state.model);
}

export function shouldRunOnboarding(state: OnboardingStartupState): boolean {
	// Whenever no usable model is configured, send the user to the
	// provider/model configuration menu — on first run and on every later
	// launch until a model works.
	state.modelRegistry.refresh();
	return !isOnboardingModelReady(state);
}
