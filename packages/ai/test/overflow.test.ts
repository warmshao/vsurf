import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.js";
import { isContextOverflow } from "../src/utils/overflow.js";

function createErrorMessage(errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "ollama",
		model: "qwen3.5:35b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow", () => {
	it("detects explicit Ollama prompt-too-long errors", () => {
		const message = createErrorMessage("400 `prompt too long; exceeded max context length by 100918 tokens`");
		expect(isContextOverflow(message, 32768)).toBe(true);
	});

	it("does not treat generic non-overflow Ollama errors as overflow", () => {
		const message = createErrorMessage("500 `model runner crashed unexpectedly`");
		expect(isContextOverflow(message, 32768)).toBe(false);
	});

	it("does not treat Bedrock throttling 'Too many tokens' as overflow", () => {
		// Bedrock returns this for HTTP 429 rate limiting, NOT context overflow.
		// formatBedrockError uses a human-readable prefix for ThrottlingException.
		const message = createErrorMessage("Throttling error: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat Bedrock service unavailable as overflow", () => {
		const message = createErrorMessage("Service unavailable: The service is temporarily unavailable.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat generic rate limit errors as overflow", () => {
		const message = createErrorMessage("Rate limit exceeded, please retry after 30 seconds.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat HTTP 429 style errors as overflow", () => {
		const message = createErrorMessage("Too many requests. Please slow down.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("treats a bodyless 400 as overflow only for Cerebras", () => {
		const cerebrasMessage = { ...createErrorMessage("400 status code (no body)"), provider: "cerebras" };
		expect(isContextOverflow(cerebrasMessage, 200000)).toBe(true);
	});

	it("does not treat a bodyless 400 from an OpenAI-compatible relay as overflow", () => {
		// A relay rejecting a request (bad params, unsupported image input, …)
		// with an empty body produces the same "400 status code (no body)"
		// string — that is not context overflow and must not trigger compaction.
		const message = { ...createErrorMessage("400 status code (no body)"), provider: "openai-compatible" };
		expect(isContextOverflow(message, 200000)).toBe(false);
		const cerebras413 = { ...createErrorMessage("413 status code (no body)"), provider: "cerebras" };
		expect(isContextOverflow(cerebras413, 200000)).toBe(true);
	});

	function createLengthStopMessage(input: number, cacheRead: number, output: number): AssistantMessage {
		return {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "xiaomi",
			model: "mimo-v2.5-pro",
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite: 0,
				totalTokens: input + cacheRead + output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	it("detects Xiaomi-style overflow (length stop with zero output and filled context)", () => {
		const message = createLengthStopMessage(58, 1048512, 0);
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("does not treat normal length stops with output as overflow", () => {
		const message = createLengthStopMessage(1000, 0, 4096);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat length stops far below context as overflow", () => {
		const message = createLengthStopMessage(100, 0, 0);
		expect(isContextOverflow(message, 200000)).toBe(false);
	});
});
