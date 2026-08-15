import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
	},
	resolve: {
		alias: [
			{ find: /^@earendil-works\/vsurf-ai$/, replacement: aiSrcIndex },
			{ find: /^@earendil-works\/vsurf-ai\/oauth$/, replacement: aiSrcOAuth },
			{ find: /^@mariozechner\/vsurf-ai$/, replacement: aiSrcIndex },
			{ find: /^@mariozechner\/vsurf-ai\/oauth$/, replacement: aiSrcOAuth },
		],
	},
});
