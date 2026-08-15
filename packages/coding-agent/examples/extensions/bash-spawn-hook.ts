/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   vsurf -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "vsurf";
import { createBashTool } from "vsurf";

export default function (vsurf: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, VSURF_SPAWN_HOOK: "1" },
		}),
	});

	vsurf.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
