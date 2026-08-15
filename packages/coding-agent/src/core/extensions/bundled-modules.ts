/**
 * Modules made available to extensions via jiti virtualModules in the compiled
 * Bun binary.
 *
 * These imports MUST be static so Bun bundles them into the compiled binary;
 * the module itself is loaded lazily (dynamic import with a literal specifier,
 * which Bun also bundles) so that merely importing the extension loader does
 * not pull in the entire package graph at startup.
 */

import * as _bundledTypebox from "typebox";
import * as _bundledTypeboxCompile from "typebox/compile";
import * as _bundledTypeboxValue from "typebox/value";
import * as _bundledPiAgentCore from "vsurf-agent";
import * as _bundledPiAi from "vsurf-ai";
import * as _bundledPiAiOauth from "vsurf-ai/oauth";
import * as _bundledPiTui from "vsurf-tui";
// NOTE: This import works because loader.ts exports are NOT re-exported from index.ts,
// avoiding a circular dependency. Extensions can import from vsurf.
import * as _bundledPiCodingAgent from "../../index.js";

export const VIRTUAL_MODULES: Record<string, unknown> = {
	typebox: _bundledTypebox,
	"typebox/compile": _bundledTypeboxCompile,
	"typebox/value": _bundledTypeboxValue,
	"@sinclair/typebox": _bundledTypebox,
	"@sinclair/typebox/compile": _bundledTypeboxCompile,
	"@sinclair/typebox/value": _bundledTypeboxValue,
	"vsurf-agent": _bundledPiAgentCore,
	"vsurf-tui": _bundledPiTui,
	"vsurf-ai": _bundledPiAi,
	"vsurf-ai/oauth": _bundledPiAiOauth,
	vsurf: _bundledPiCodingAgent,
	"@mariozechner/vsurf-agent": _bundledPiAgentCore,
	"@mariozechner/vsurf-tui": _bundledPiTui,
	"@mariozechner/vsurf-ai": _bundledPiAi,
	"@mariozechner/vsurf-ai/oauth": _bundledPiAiOauth,
	"@mariozechner/vsurf": _bundledPiCodingAgent,
};
