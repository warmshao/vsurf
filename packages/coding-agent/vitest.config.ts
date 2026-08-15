import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));
const aiSrcMcp = fileURLToPath(new URL("../ai/src/mcp.ts", import.meta.url));
const agentSrcIndex = fileURLToPath(new URL("../agent/src/index.ts", import.meta.url));
const tuiSrcIndex = fileURLToPath(new URL("../tui/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		tags: [
			{
				name: "process-stress",
				description: "Slow real-process stress and wall-clock scheduling coverage",
			},
			{
				name: "kernel-heavy",
				description: "Boots a real IPython kernel and syncs skills into the shared venv",
			},
		],
		// Kernel-heavy tests are excluded from the default sharded run: several files
		// booting real kernels in one shard starve the neighbouring kernel tests that
		// rely on the 30s default timeout. `test:kernel` runs them on their own.
		tagsFilter: ["!process-stress", "!kernel-heavy"],
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/vsurf-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/vsurf-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@earendil-works\/vsurf-ai\/mcp$/, replacement: aiSrcMcp },
			{ find: /^@earendil-works\/vsurf-agent$/, replacement: agentSrcIndex },
			{ find: /^@earendil-works\/vsurf-tui$/, replacement: tuiSrcIndex },
			{ find: /^@mariozechner\/vsurf-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/vsurf-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/vsurf-ai\/mcp$/, replacement: aiSrcMcp },
			{ find: /^@mariozechner\/vsurf-agent$/, replacement: agentSrcIndex },
			{ find: /^@mariozechner\/vsurf-tui$/, replacement: tuiSrcIndex },
		],
	},
});
