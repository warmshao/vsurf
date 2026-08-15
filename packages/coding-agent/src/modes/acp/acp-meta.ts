/**
 * Namespaced `_meta` payloads for vsurf capabilities that ACP has no
 * native concept for (IPython cell semantics, RLM subagents, autonomous gates,
 * goals, heartbeats, continual harness state).
 *
 * ACP reserves `_meta` on capability objects, notifications, tool calls, and
 * content blocks precisely so agents can carry non-standard data. Vanilla ACP
 * clients ignore these keys; a vsurf-aware client (or the verifiers
 * harness) reads them. Never add non-standard fields to an ACP object root.
 */

/** Reverse-domain namespace for every vsurf `_meta` payload. */
export const VSURF_META_NAMESPACE = "ai.primeintellect.vsurf";

export interface VsurfSubagentMeta {
	id: string;
	sessionName?: string;
	status: string;
	model?: string;
	depth?: number;
	tokenCount?: number;
	error?: string;
}

export interface VsurfAutonomousMeta {
	enabled: boolean;
	continuationsUsed: number;
	turnsUsed: number;
	tokensUsed: number;
	gateAttempt?: number;
	gateFailure?: string;
	limitReason?: string;
}

export interface VsurfIpythonAttachmentMeta {
	mimeType?: string;
	path?: string;
	bytes?: number;
}

export interface VsurfIpythonMeta {
	/** Media the cell loaded into context, as reported by the ipython tool. */
	attachments?: VsurfIpythonAttachmentMeta[];
	/** Number of diffs the cell displayed. */
	diffCount?: number;
}

export interface VsurfGoalMeta {
	status: string;
	objective?: string;
	tokenBudget?: number;
	tokensUsed?: number;
}

export interface VsurfRefinementMeta {
	status: "complete" | "failed";
	summary?: string;
	changes?: string[];
	error?: string;
}

export interface VsurfAgentMessageMeta {
	toolCallId: string;
	target?: string;
	deliveryStatus?: string;
}

export interface VsurfCwdMeta {
	/** The cwd the client asked for. */
	requested: string;
	/** The cwd vsurf is actually running in, fixed at startup. */
	actual: string;
}

export interface VsurfSessionMeta {
	/** Present when a client-requested cwd differs from the agent's real cwd. */
	cwd?: VsurfCwdMeta;
	/** Set when the session's heartbeat or cron schedule changed. */
	heartbeatsChanged?: boolean;
	goal?: VsurfGoalMeta;
	refinement?: VsurfRefinementMeta;
	agentMessage?: VsurfAgentMessageMeta;
	sessionId?: string;
	rlmDepth?: number;
	rlmMaxDepth?: number;
	compaction?: { tokensBefore?: number; summary?: string };
	subagents?: VsurfSubagentMeta[];
	autonomous?: VsurfAutonomousMeta;
	ipython?: VsurfIpythonMeta;
}

/** Wrap a vsurf payload in its reverse-domain `_meta` envelope. */
export function vsurfMeta(payload: VsurfSessionMeta): Record<string, unknown> {
	return { [VSURF_META_NAMESPACE]: payload };
}
