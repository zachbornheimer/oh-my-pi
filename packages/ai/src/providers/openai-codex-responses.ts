import { scheduler } from "node:timers/promises";
import { type } from "@oh-my-pi/omptype";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	codexRoutingHint,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { getCodexClientVersion } from "@oh-my-pi/pi-catalog/wire/codex-version";
import {
	$env,
	$flag,
	asRecord,
	toError,
	cloneJsonTree,
	fetchWithRetry,
	getInstallId,
	logger,
	readSseJson,
	structuredCloneJSON,
	USER_AGENT,
} from "@oh-my-pi/pi-utils";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import * as AIError from "../error";
import { parseToolCallArguments, replayableToolCallArguments } from "../utils/tool-call-arguments";
import { getEnvApiKey } from "../env-api-key";
import type {
	Api,
	AssistantMessage,
	CodexCompactionRequestContext,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
	Usage,
} from "../types";
import { getPremiumServiceTierRequests, parseServiceTier } from "../types";
import {
	clampOpenAIResponsesImageDetailForReplay,
	createOpenAIResponsesHistoryPayload,
	dropMalformedOpenAIResponsesToolCalls,
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeSystemPrompts,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
	stripOpenAIResponsesComputerLinkedReasoningIdsForReplay,
} from "../utils";
import { clearStreamingPartialJson, kStreamingLastParseLen, kStreamingPartialJson } from "../utils/block-symbols";
import { hasVisibleAssistantContent } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { escapeHarmonyControlTokens, isHarmonyDialectModel } from "../utils/harmony-leak";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import {
	armPreResponseTimeout,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import { getProxyForUrl } from "../utils/proxy";
import { wrapFetchForRequestCompression } from "../utils/request-compression";
import { getHeadersFromError, getRetryAfterMsFromHeaders, type HeadersLike } from "../utils/retry-after";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { toWebSocketHeaders, toWebSocketUrl } from "../utils/websocket";
import { compactGrammarDefinition } from "./grammar";
import {
	type CodexLiteShapedBody,
	type CodexReasoningContext,
	type CodexRequestOptions,
	type InputItem,
	type ReasoningConfig,
	lowestCodexWireEffort,
	type RequestBody,
	resolveCodexResponsesLite,
	sanitizeCodexCallId,
	transformRequestBody,
	withCodexRoutingFieldsFirst,
} from "./openai-codex/request-transformer";
import { applyCodexAccessPrograms, dropRejectedCodexAccessPrograms } from "./openai-codex/access-programs";
import {
	type CodexAcceptedSteer,
	type CodexSteerAck,
	CodexSteerPump,
	planSteeredRequest,
	toSteerInputItems,
} from "./openai-codex/live-steering";
import { CodexApiError } from "./openai-codex/response-handler";
import { getCodexAttestationHeader } from "./openai-codex-attestation";
export { createOpenAICodexCompactionRequestContext } from "./openai-codex-compaction";
import { getOpenAICodexWebSocketEnvValue } from "./openai-codex-transport";
import {
	createCodexProviderSessionState,
	getCodexProviderSessionState,
	resetCodexWebSocketAppendState,
} from "./openai-codex-state";
export { setCodexAttestationProvider } from "./openai-codex-attestation";
export type { CodexAttestationProvider } from "./openai-codex-attestation";
import {
	type OpenAIEffortControlState,
	planStableOpenAIEffort,
	resolveOpenAIEffortControlState,
} from "./openai-configuration-update";
import type {
	ResponseComputerToolCall,
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
} from "./openai-responses-wire";
import {
	accumulateCustomToolCallInputDelta,
	accumulateToolCallArgumentsDelta,
	appendMessageContentPart,
	appendMessageTextDelta,
	appendReasoningSummaryPart,
	appendReasoningSummaryPartDone,
	appendReasoningSummaryTextDelta,
	appendResponsesImageResult,
	appendResponsesToolResultMessages,
	applyOpenAIServiceTier,
	applyReasoningSummaryDone,
	buildResponsesDeltaInput,
	computerCallMetadata,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createSequentialCutoffSummaryState,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	escapeReplayedControlTokens,
	finalizeCustomToolCallInputDone,
	finalizeMessageText,
	finalizePendingResponsesToolCalls,
	isOpenAIResponsesStalePreviousResponseError,
	finalizeReasoningThinking,
	finalizeToolCallArgumentsDone,
	getOpenAIPromptCacheKey,
	hasExecutableIncompleteResponsesToolCalls,
	mapOpenAIResponsesStopReason,
	normalizeOpenAIPromptCacheKey,
	pickUnrecordedResponsesToolCalls,
	populateResponsesUsageFromResponse,
	parseAssistantMessagePhase,
	promoteResponsesToolUseStopReason,
	settleReasoningSummary,
	type SequentialCutoffSummaryState,
} from "./openai-shared";
import {
	isResponsesWebSocketProgressEvent,
	ResponsesWebSocketConnection,
	ResponsesWebSocketTransportError,
} from "./responses-websocket-connection";
import { normalizeToolCallId, redactSensitiveInObject, transformMessages } from "./transform-messages";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	/**
	 * Run with the least reasoning the model allows; takes precedence over
	 * `reasoning`. Sends the `none` tier where the catalog's disable mode is
	 * `none-effort`, else the model's lowest supported effort.
	 */
	disableReasoning?: boolean;
	reasoningSummary?: "auto" | "concise" | "detailed" | null;
	/** Explicit `reasoning.context` replay scope. Omitted by default so Codex applies its native request policy. */
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	codexMode?: boolean;
	toolChoice?: ToolChoice;
	preferWebsockets?: boolean;
	serviceTier?: ServiceTier;
	/**
	 * Responses Lite transport opt-in. Normal inference defaults to full
	 * Responses; provider-native compaction explicitly follows the model's
	 * `useResponsesLite` flag.
	 */
	responsesLite?: boolean;
	/**
	 * Additional fields embedded in the canonical
	 * `client_metadata["x-codex-turn-metadata"]` JSON blob. Reserved identity
	 * keys are ignored; extras are never emitted as top-level metadata fields.
	 */
	clientMetadata?: Record<string, string>;
	/**
	 * Turn id of the initiating (parent) Codex turn for nested requests such as
	 * subagent spawns (codex-rs `parent_turn_id`, #35835). Emitted both as the
	 * flat `client_metadata.parent_turn_id` key and inside the
	 * `x-codex-turn-metadata` JSON blob; blank values are ignored. The key is
	 * reserved: `clientMetadata` extras cannot supply it.
	 */
	parentTurnId?: string;
	/**
	 * Invoked when the server streams a `response.metadata` event carrying
	 * ChatGPT moderation metadata (`metadata.openai_chatgpt_moderation_metadata`)
	 * for first-party presentation parity. Diagnostic observer: failures are
	 * swallowed and must not alter the stream.
	 */
	onModerationMetadata?: (metadata: unknown) => void;
}

/** Raw V2 compaction body accepted by the Codex transport selector. */
export interface OpenAICodexCompactionBody extends CodexLiteShapedBody {
	model: string;
	[key: string]: unknown;
}

/** Transport controls for a provider-native Codex V2 compaction stream. */
export interface OpenAICodexCompactionStreamOptions extends OpenAICodexResponsesOptions {
	apiKey: string;
}

/** Inputs for synthesizing Codex request identity outside the normal stream path. */
export interface OpenAICodexCompatibilityMetadataOptions {
	sessionId?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
	requestKind: OpenAICodexRequestKind;
	compaction?: CodexCompactionRequestContext;
	startNewTurn?: boolean;
	turnStartedAtUnixMs?: number;
	clientMetadata?: Readonly<Record<string, string>>;
	/** Parent Codex turn id for nested requests; see {@link OpenAICodexResponsesOptions.parentTurnId}. */
	parentTurnId?: string;
	/** Add the direct installation header required by `/responses/compact`. */
	includeInstallationHeader?: boolean;
}

/** Canonical Codex body metadata and compatibility headers for one request. */
export interface OpenAICodexCompatibilityMetadata {
	clientMetadata: Record<string, string>;
	headers: Record<string, string>;
}

const CODEX_DEBUG = $flag("PI_CODEX_DEBUG");
const CODEX_MAX_RETRIES = 5;
const CODEX_RETRY_DELAY_MS = 500;

function resolveCodexSseMaxAttempts(value: number | undefined): number {
	if (value === undefined) return CODEX_MAX_RETRIES + 1;
	if (!Number.isFinite(value)) return 1;
	return Math.max(1, Math.trunc(value));
}
const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10000;
const CODEX_WEBSOCKET_PING_INTERVAL_MS = Number($env.PI_CODEX_WEBSOCKET_PING_INTERVAL_MS || 10_000);
const CODEX_WEBSOCKET_PONG_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_PONG_TIMEOUT_MS || 60_000);
const CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY = Number($env.PI_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY || 4096);
/**
 * Maximum quiet period (no inbound frames AND no observed pong) we'll trust a
 * reused WebSocket for before forcing a fresh handshake. Codex backends and
 * intermediaries occasionally evict idle sockets server-side without sending a
 * FIN, leaving the local `readyState` as OPEN while the next `send()` becomes a
 * write into a half-open buffer. Reusing such a socket parks the next request
 * at `#nextMessage` until the first-event/idle timeout fires (issue #1450). The
 * heartbeat below also catches dead sockets, but only after `pongTimeoutMs`
 * (default 60s) and only while a request is active — this gate closes the door
 * earlier and even when the gap between requests is purely client-side (tool
 * execution, user typing, etc.). Set `PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS=0`
 * to disable.
 */
const CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS = Number($env.PI_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS || 30_000);
/**
 * Steady-state liveness ceiling for the Codex WebSocket transport. Distinct from
 * the OMP-wide stream watchdog removed in #1392: a WebSocket can stay TCP-open
 * indefinitely without exchanging frames (server crash after upgrade, half-open
 * network path), so we still need a transport-internal cap to detect those
 * states and trigger the WS→SSE fallback. Only applies AFTER the first event
 * has arrived — slow first-token paths wait as long as the caller permits.
 */
const CODEX_WEBSOCKET_IDLE_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS || 300_000);
/**
 * Maximum wait for the first WebSocket event before falling back to SSE.
 * Unlike a stream watchdog, this triggers a transport switch (not a request
 * failure) — the outer retry loop catches the timeout error and re-runs on
 * SSE. Generous default so legitimately slow first-token providers still get
 * a chance on the WS transport before falling through.
 */
const CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS = Number($env.PI_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS || 300_000);
const CODEX_WEBSOCKET_RETRY_BUDGET = Number($env.PI_CODEX_WEBSOCKET_RETRY_BUDGET || CODEX_MAX_RETRIES);
const CODEX_WEBSOCKET_RETRY_DELAY_MS = Number($env.PI_CODEX_WEBSOCKET_RETRY_DELAY_MS || CODEX_RETRY_DELAY_MS);
const CODEX_WEBSOCKET_TRANSPORT_ERROR_PREFIX = "Codex websocket transport error";
// The native-lane steering rejection is replayable: the session stops steering
// first, so the replay cannot trip it again.
const CODEX_RETRYABLE_EVENT_CODES = new Set([
	"model_error",
	"server_error",
	"internal_error",
	AIError.CODEX_NATIVE_LANE_STEER_REJECTED_CODE,
]);
/**
 * Turn lanes (see `#steeringLaneKey`) that refused a steer, shared across sessions so each new
 * session queues follow-ups instead of losing a response to the same refusal. Entries expire so
 * server-side support is picked up once it ships.
 */
const unsupportedSteeringLanes = new LRUCache<string, true>({ max: 256, ttl: 4 * 60 * 60 * 1000 });
const CODEX_RETRYABLE_EVENT_MESSAGE =
	/processing your request|retry your request|temporar(?:y|ily)|overloaded|service.?unavailable|internal error|server error/i;

const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
const X_MODELS_ETAG_HEADER = "x-models-etag";
/** WebSocket frames cannot carry per-request HTTP headers; codex-rs mirrors the lite marker into `client_metadata` under this key. */
const CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
/** `response.metadata` payload key carrying ChatGPT moderation metadata. */
const CODEX_MODERATION_METADATA_KEY = "openai_chatgpt_moderation_metadata";
/** Connection-level websocket failures that should immediately fall back to SSE without retrying. */
const CODEX_WEBSOCKET_FATAL_PATTERNS = ["websocket error:", "websocket closed before open", "connection timeout"];
/** Max total time to spend retrying 429s with server-provided delays (5 minutes). */
const CODEX_RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
// Provider/model failure mode: Codex can keep a response alive by streaming
// whitespace-only function-call argument deltas forever. Those frames count as
// transport activity, so idle timers never fire; cap the run before raw debug
// buffers and partial JSON grow without semantic progress.
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT = 256;
const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT = 16 * 1024;
const CODEX_WHITESPACE_LOOP_RETRY_LIMIT = 2;
const CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS = 250;

export type CodexTransport = "sse" | "websocket";
type CodexEventItem =
	| ResponseReasoningItem
	| ResponseOutputMessage
	| ResponseFunctionToolCall
	| ResponseCustomToolCall
	| ResponseComputerToolCall
	| ResponseOutputItem.ImageGenerationCall;
type CodexOutputBlock =
	| ThinkingContent
	| TextContent
	| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number });

interface CodexResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number;
	input_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
		orchestration_input_tokens?: number;
		orchestration_input_cached_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
		orchestration_output_tokens?: number;
	};
}

/** Shape of the Codex request sent on the latest provider turn. */
export interface OpenAICodexTurnRequestDiagnostics {
	transport: "sse" | "websocket";
	previousResponseIdPresent: boolean;
	inputItemCount: number;
	inputItemTypes: string[];
	firstInputItemType?: string;
	inputJsonBytes: number;
	promptCacheKey?: string;
	toolsHash?: string;
	optionsHash: string;
	canAppendBeforeRequest: boolean;
}

/** Raw provider usage plus the normalized buckets OMP displays for the latest Codex turn. */
export interface OpenAICodexTurnUsageDiagnostics {
	rawInputTokens: number;
	rawCachedTokens: number;
	rawUncachedTokens: number;
	rawOutputTokens: number;
	rawTotalTokens?: number;
	rawOrchestrationInputTokens?: number;
	rawOrchestrationCachedTokens?: number;
	rawOrchestrationOutputTokens?: number;
	displayedInputTokens: number;
	displayedOutputTokens: number;
	displayedCacheReadTokens: number;
	displayedCacheWriteTokens: number;
	displayedTotalTokens: number;
	displayedOrchestrationInputTokens: number;
	displayedOrchestrationCacheReadTokens: number;
	displayedOrchestrationOutputTokens: number;
}

/** Latest Codex turn request/usage diagnostics exposed to debug UIs and tests. */
export interface OpenAICodexTurnDiagnostics {
	request: OpenAICodexTurnRequestDiagnostics;
	usage?: OpenAICodexTurnUsageDiagnostics;
}

/**
 * Per-session request-shape counters and latest turn diagnostics. Despite the
 * name, these cover both transports.
 */
export interface OpenAICodexWebSocketDebugStats {
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	lastTurn?: OpenAICodexTurnDiagnostics;
}

/**
 * Per-session transport state shared by both transports: WebSocket turn
 * chaining, models-etag headers, connection pooling, and debug stats. The name
 * is historical — SSE-only sessions use it too.
 */
export type CodexWebSocketSessionState = {
	sessionId: string;
	disableWebsocket: boolean;
	lastRequest?: RequestBody;
	/** Last completed response; an in-progress response cannot replace the retry baseline. */
	lastResponseId?: string;
	lastResponseItems?: InputItem[];
	canAppend: boolean;
	modelsEtag?: string;
	connection?: CodexWebSocketConnection;
	/**
	 * Steering the server accepted on `connection` for `lastResponseId`. The
	 * next request reads the server's automatic successor or sends only the
	 * pending tool output; see {@link planSteeredRequest}.
	 */
	acceptedSteering?: { connection: CodexWebSocketConnection; steers: CodexAcceptedSteer[] };
	/** The server refused steering for this session (native turn lane); later responses are not steered. */
	steeringUnsupported?: boolean;
	lastTransport?: CodexTransport;
	fallbackCount: number;
	lastFallbackAt?: number;
	prewarmed: boolean;
	stats: OpenAICodexWebSocketDebugStats;
};

interface CodexTurnStateCell {
	value?: string;
}

export interface CodexProviderSessionState extends ProviderSessionState {
	webSocketSessions: Map<string, CodexWebSocketSessionState>;
	webSocketPublicToPrivate: Map<string, string>;
	metadataSessions: Map<string, CodexMetadataSessionState>;
	/** `configuration_update` effort baselines, keyed by model + session. */
	effortControls: Map<string, OpenAIEffortControlState<ReasoningConfig["effort"]>>;
}

/** Request classification encoded in Codex turn metadata. */
export type OpenAICodexRequestKind = "turn" | "prewarm" | "compaction";

interface CodexMetadataSessionState {
	sessionId: string;
	threadId: string;
	windowId: string;
	turnId?: string;
	turnStartedAtUnixMs?: number;
	compactionOperationId?: string;
	reuseTurnForNextRequest?: boolean;
	turnStates: Map<string, CodexTurnStateCell>;
}

interface CodexCompatibilityIdentity {
	installationId: string;
	sessionId: string;
	/**
	 * Session the backend derives prompt-cache affinity from, sent in every
	 * session header: the parent conversation's for a side request
	 * (`parentSessionId`), else `sessionId`. Turn metadata keeps `sessionId`.
	 */
	affinitySessionId?: string;
	threadId: string;
	windowId: string;
	turnMetadataJson?: string;
}

interface CodexRequestMetadata extends CodexCompatibilityIdentity {
	turnId: string;
	turnMetadataJson: string;
	clientMetadata: Record<string, string>;
}

const CODEX_RESERVED_METADATA_KEYS: Record<string, true> = {
	installation_id: true,
	[OPENAI_HEADERS.INSTALLATION_ID]: true,
	session_id: true,
	thread_id: true,
	turn_id: true,
	window_id: true,
	[OPENAI_HEADERS.WINDOW_ID]: true,
	[OPENAI_HEADERS.TURN_METADATA]: true,
	[OPENAI_HEADERS.PARENT_THREAD_ID]: true,
	[OPENAI_HEADERS.SUBAGENT]: true,
	request_kind: true,
	compaction: true,
	turn_started_at_unix_ms: true,
	forked_from_thread_id: true,
	parent_thread_id: true,
	parent_turn_id: true,
	subagent_kind: true,
	thread_source: true,
	sandbox: true,
	workspaces: true,
};

function createCodexMetadataSessionState(sessionId: string): CodexMetadataSessionState {
	return {
		sessionId,
		threadId: crypto.randomUUID(),
		windowId: crypto.randomUUID(),
		turnStates: new Map(),
	};
}

function getOrCreateCodexMetadataSessionState(
	sessionId: string,
	providerState: CodexProviderSessionState | undefined,
): CodexMetadataSessionState {
	if (!providerState) return createCodexMetadataSessionState(sessionId);
	const existing = providerState.metadataSessions.get(sessionId);
	if (existing) return existing;
	const created = createCodexMetadataSessionState(sessionId);
	providerState.metadataSessions.set(sessionId, created);
	return created;
}

function getOrCreateCodexTurnState(
	session: CodexMetadataSessionState,
	compatibilityKey: string | undefined,
): CodexTurnStateCell {
	if (!compatibilityKey) return {};
	const existing = session.turnStates.get(compatibilityKey);
	if (existing) return existing;
	const created: CodexTurnStateCell = {};
	session.turnStates.set(compatibilityKey, created);
	return created;
}

/**
 * Drop every compatibility-scoped sticky-routing token when a fresh logical
 * turn begins, mirroring codex-rs's per-turn `OnceLock`. Standalone compaction
 * owns a throwaway cell, so it never disturbs the live turn's tokens. Runs on
 * every entry path that opens a turn — the normal stream (`createCodexRequestContext`)
 * and the raw compaction routes (`createOpenAICodexCompatibilityMetadata`).
 */
function clearCodexTurnStatesForNewTurn(
	session: CodexMetadataSessionState,
	startNewTurn: boolean,
	compaction: CodexCompactionRequestContext | undefined,
): void {
	if (startNewTurn && compaction?.phase !== "standalone_turn") session.turnStates.clear();
}

function createCodexCompatibilityIdentity(session: CodexMetadataSessionState): CodexCompatibilityIdentity {
	return {
		installationId: getInstallId(),
		sessionId: session.sessionId,
		threadId: session.threadId,
		windowId: session.windowId,
	};
}

function resolveCodexStartNewTurn(
	session: CodexMetadataSessionState,
	requestKind: OpenAICodexRequestKind,
	compaction: CodexCompactionRequestContext | undefined,
	override: boolean | undefined,
): boolean {
	if (requestKind !== "compaction") {
		if (requestKind === "turn") {
			const reuseCompactionTurn = session.reuseTurnForNextRequest === true;
			session.reuseTurnForNextRequest = false;
			session.compactionOperationId = undefined;
			if (reuseCompactionTurn) return false;
		}
		return override ?? requestKind === "turn";
	}
	if (!compaction) return override ?? false;
	const startsNewOperation = session.compactionOperationId !== compaction.operationId;
	if (startsNewOperation) session.reuseTurnForNextRequest = false;
	session.compactionOperationId = compaction.operationId;
	return override ?? (compaction.phase !== "mid_turn" && startsNewOperation);
}

function toAsciiJsonString(value: Record<string, unknown>): string {
	return JSON.stringify(value).replace(
		/[\x7f-\uffff]/g,
		char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function createCodexRequestMetadata(
	session: CodexMetadataSessionState,
	requestKind: OpenAICodexRequestKind,
	options: {
		startNewTurn: boolean;
		turnStartedAtUnixMs?: number;
		clientMetadata?: Readonly<Record<string, string>>;
		parentTurnId?: string;
		compaction?: CodexCompactionRequestContext;
		affinitySessionId?: string;
	},
): CodexRequestMetadata {
	if (options.startNewTurn || !session.turnId) {
		session.turnId = crypto.randomUUID();
		session.turnStartedAtUnixMs = options.turnStartedAtUnixMs;
	}
	const identity = createCodexCompatibilityIdentity(session);
	// codex-rs `set_parent_turn_id` ignores blank values; keep the original
	// spelling when non-blank.
	const parentTurnId = options.parentTurnId?.trim() ? options.parentTurnId : undefined;
	const extra: Record<string, string> = {};
	const callerMetadata = options.clientMetadata;
	if (callerMetadata) {
		for (const key in callerMetadata) {
			if (!CODEX_RESERVED_METADATA_KEYS[key]) extra[key] = callerMetadata[key];
		}
	}
	const turnMetadata: Record<string, unknown> = {
		installation_id: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		turn_id: session.turnId,
		window_id: identity.windowId,
		request_kind: requestKind,
	};
	if (parentTurnId) turnMetadata.parent_turn_id = parentTurnId;
	if (options.compaction) {
		turnMetadata.compaction = {
			trigger: options.compaction.trigger,
			reason: options.compaction.reason,
			implementation: options.compaction.implementation,
			phase: options.compaction.phase,
			strategy: options.compaction.strategy,
		};
	}
	if (session.turnStartedAtUnixMs !== undefined) {
		turnMetadata.turn_started_at_unix_ms = session.turnStartedAtUnixMs;
	}
	for (const key in extra) turnMetadata[key] = extra[key];
	const turnMetadataJson = toAsciiJsonString(turnMetadata);
	const clientMetadata: Record<string, string> = {
		[OPENAI_HEADERS.INSTALLATION_ID]: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		[OPENAI_HEADERS.WINDOW_ID]: identity.windowId,
		turn_id: session.turnId,
	};
	// Both projections, mirroring codex-rs `CodexResponsesMetadata::to_client_metadata`:
	// the flat key above/below AND the field inside the turn-metadata JSON.
	if (parentTurnId) clientMetadata.parent_turn_id = parentTurnId;
	clientMetadata[OPENAI_HEADERS.TURN_METADATA] = turnMetadataJson;
	return {
		...identity,
		affinitySessionId: options.affinitySessionId,
		turnId: session.turnId,
		turnMetadataJson,
		clientMetadata,
	};
}

function applyCodexCompatibilityHeaders(headers: Headers, metadata: CodexCompatibilityIdentity): void {
	headers.set(OPENAI_HEADERS.SCOPED_SESSION_ID, metadata.affinitySessionId ?? metadata.sessionId);
	headers.set(OPENAI_HEADERS.THREAD_ID, metadata.threadId);
	headers.set(OPENAI_HEADERS.WINDOW_ID, metadata.windowId);
	if (metadata.turnMetadataJson) {
		headers.set(OPENAI_HEADERS.TURN_METADATA, metadata.turnMetadataJson);
	} else {
		headers.delete(OPENAI_HEADERS.TURN_METADATA);
	}
}

/**
 * Synthesize Codex request identity for raw provider routes such as remote
 * compaction while reusing the live session's thread, window, and turn.
 */
export function createOpenAICodexCompatibilityMetadata(
	options: OpenAICodexCompatibilityMetadataOptions,
): OpenAICodexCompatibilityMetadata {
	const providerState = getCodexProviderSessionState(options.providerSessionState);
	const sessionId = normalizeOpenAIPromptCacheKey(options.sessionId) ?? crypto.randomUUID();
	const session = getOrCreateCodexMetadataSessionState(sessionId, providerState);
	const startNewTurn = resolveCodexStartNewTurn(
		session,
		options.requestKind,
		options.compaction,
		options.startNewTurn,
	);
	clearCodexTurnStatesForNewTurn(session, startNewTurn, options.compaction);
	const metadata = createCodexRequestMetadata(session, options.requestKind, {
		startNewTurn,
		turnStartedAtUnixMs: options.turnStartedAtUnixMs ?? (startNewTurn || !session.turnId ? Date.now() : undefined),
		clientMetadata: options.clientMetadata,
		parentTurnId: options.parentTurnId,
		compaction: options.compaction,
	});
	const headers = new Headers();
	applyCodexCompatibilityHeaders(headers, metadata);
	if (options.includeInstallationHeader) {
		headers.set(OPENAI_HEADERS.INSTALLATION_ID, metadata.installationId);
	}
	return {
		clientMetadata: { ...metadata.clientMetadata },
		headers: Object.fromEntries(headers.entries()),
	};
}

interface CodexRequestContext {
	apiKey: string;
	accountId?: string;
	baseUrl: string;
	url: string;
	requestHeaders: Record<string, string>;
	codexClientVersion: string;
	transportSessionId?: string;
	providerSessionState?: CodexProviderSessionState;
	isolatedTransportState?: CodexProviderSessionState;
	websocketState?: CodexWebSocketSessionState;
	turnState: CodexTurnStateCell;
	responsesLite: boolean;
	requestMetadata?: CodexRequestMetadata;
	transformedBody: RequestBody;
	rawRequestDump: RawHttpRequestDump;
}

interface CodexRequestSetup {
	requestSignal: AbortSignal;
	wrapCodexSseStream: (source: AsyncGenerator<Record<string, unknown>>) => AsyncGenerator<Record<string, unknown>>;
	requestAbortController: AbortController;
	firstEventTimeoutMs: number | undefined;
	websocketIdleTimeoutMs: number | undefined;
	websocketFirstEventTimeoutMs: number | undefined;
}

interface CodexOpenItem {
	item: CodexEventItem;
	block: CodexOutputBlock | null;
	/** Index of {@link block} in `output.content`; `-1` when no block was created for this item. */
	contentIndex: number;
	itemId?: string;
	outputIndex?: number;
	nativeOutputItem?: Record<string, unknown>;
}

class CodexStreamRuntime {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;
	/**
	 * Items open on the wire keyed by `item.id`. `response.output_item.added`
	 * registers here; `output_item.done` removes. A keyed event whose `item_id`
	 * is not present is dropped rather than appended to a sibling.
	 */
	openItems = new Map<string, CodexOpenItem>();
	/**
	 * Items open on the wire keyed by `output_index` for streams whose function
	 * call items omit `id`; these still carry `output_index` on deltas/done.
	 */
	openItemsByOutputIndex = new Map<number, CodexOpenItem>();
	/**
	 * Most recently added open item for events that omit both `item_id` and
	 * `output_index`. Always tracks the latest `output_item.added`, including
	 * fully keyless items that never make it into the keyed maps; cleared when
	 * its item closes.
	 */
	currentEntry: CodexOpenItem | null = null;
	/** Convenience mirrors of {@link currentEntry} for legacy singleton handlers. */
	currentItem: CodexEventItem | null = null;
	currentBlock: CodexOutputBlock | null = null;
	nativeOutputItems: Array<Record<string, unknown>> = [];
	nativeOutputEntries: CodexOpenItem[] = [];
	/** Sequential-cutoff summary sections/emitted text, global to the response (indices span reasoning items). */
	cutoffSummaries: SequentialCutoffSummaryState = createSequentialCutoffSummaryState();
	/** Summary deltas buffered while waiting to see whether atomic `.done` events arrive. */
	pendingSummaryDeltas = new Map<CodexOpenItem, string[]>();
	websocketStreamRetries = 0;
	providerRetryAttempt = 0;
	sawTerminalEvent = false;
	canSafelyReplayWebsocketOverSse = true;
	whitespaceToolCallArgumentsDelta?: CodexWhitespaceToolCallArgumentsDeltaState;
	whitespaceLoopRetries = 0;

	constructor(initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
		websocketState?: CodexWebSocketSessionState;
	}) {
		this.eventStream = initial.eventStream;
		this.requestBodyForState = initial.requestBodyForState;
		this.transport = initial.transport;
		this.websocketState = initial.websocketState;
	}

	/**
	 * Wipe per-attempt accumulator state before a recovery path replays the turn.
	 * Keeps {@link openItems} and the legacy singleton-current pointers in lockstep
	 * with {@link nativeOutputItems} so a stale delta from the failed attempt can't
	 * bind to a sibling on the retry.
	 */
	resetAccumulators(): void {
		this.openItems.clear();
		this.openItemsByOutputIndex.clear();
		this.currentEntry = null;
		this.currentItem = null;
		this.currentBlock = null;
		this.nativeOutputItems.length = 0;
		this.nativeOutputEntries.length = 0;
		this.pendingSummaryDeltas.clear();
		this.cutoffSummaries = createSequentialCutoffSummaryState();
	}

	finalizeNativeOutputItems(): Array<Record<string, unknown>> {
		if (this.nativeOutputEntries.length === 0) return this.nativeOutputItems;
		const ordered: Array<Record<string, unknown>> = [];
		for (const entry of this.nativeOutputEntries) {
			if (entry.nativeOutputItem) ordered.push(entry.nativeOutputItem);
		}
		ordered.push(...this.nativeOutputItems);
		this.nativeOutputEntries.length = 0;
		this.nativeOutputItems = ordered;
		return ordered;
	}

	/**
	 * Look up the open item a Codex stream event targets. `item_id` wins because it
	 * uniquely identifies a response item; `output_index` covers idless function
	 * call items. A keyed event whose target is already closed is dropped instead
	 * of being routed to a sibling. Only streams that omit both keys fall back to
	 * {@link currentEntry} — the most recently added item, including fully keyless
	 * ones that never reached the keyed maps.
	 */
	openItemForEvent(rawEvent: Record<string, unknown>): CodexOpenItem | null {
		const itemId = typeof rawEvent.item_id === "string" ? rawEvent.item_id : "";
		if (itemId) return this.openItems.get(itemId) ?? null;
		const outputIndex =
			typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
				? Math.trunc(rawEvent.output_index)
				: undefined;
		if (outputIndex !== undefined) return this.openItemsByOutputIndex.get(outputIndex) ?? null;
		return this.currentEntry;
	}
	queueSummaryDelta(entry: CodexOpenItem | null | undefined, delta: string): void {
		if (entry?.block?.type !== "thinking" || delta.length === 0) return;
		const pending = this.pendingSummaryDeltas.get(entry) ?? [];
		pending.push(delta);
		this.pendingSummaryDeltas.set(entry, pending);
	}

	takeSummaryDeltas(entry: CodexOpenItem | null | undefined): string[] {
		if (!entry) return [];
		const pending = this.pendingSummaryDeltas.get(entry) ?? [];
		this.pendingSummaryDeltas.delete(entry);
		return pending;
	}

	closeOpenItem(entry: CodexOpenItem | null | undefined): void {
		if (!entry) return;
		if (entry.itemId) this.openItems.delete(entry.itemId);
		if (entry.outputIndex !== undefined) this.openItemsByOutputIndex.delete(entry.outputIndex);
		if (this.currentEntry === entry) {
			this.currentEntry = null;
			this.currentItem = null;
			this.currentBlock = null;
		}
	}

	observeWhitespaceToolCallArgumentsDelta(
		rawEvent: Record<string, unknown>,
		delta: string,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		if (!isJsonWhitespaceOnly(delta)) {
			this.whitespaceToolCallArgumentsDelta = undefined;
			return undefined;
		}

		const itemId =
			typeof rawEvent.item_id === "string" && rawEvent.item_id.length > 0
				? rawEvent.item_id
				: (this.currentItem?.id ?? "");
		const outputIndex =
			typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
				? Math.trunc(rawEvent.output_index)
				: undefined;
		const sequenceNumber =
			typeof rawEvent.sequence_number === "number" && Number.isFinite(rawEvent.sequence_number)
				? Math.trunc(rawEvent.sequence_number)
				: undefined;
		let state = this.whitespaceToolCallArgumentsDelta;
		if (!state || state.itemId !== itemId || state.outputIndex !== outputIndex) {
			state = {
				itemId,
				outputIndex,
				consecutiveEvents: 0,
				consecutiveChars: 0,
				firstSequenceNumber: sequenceNumber,
			};
			this.whitespaceToolCallArgumentsDelta = state;
		}

		state.consecutiveEvents += 1;
		state.consecutiveChars += delta.length;
		state.lastSequenceNumber = sequenceNumber;
		if (
			state.consecutiveEvents < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT &&
			state.consecutiveChars < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT
		) {
			return undefined;
		}

		const itemLabel = itemId ? ` for item ${itemId}` : "";
		const sequenceLabel =
			state.firstSequenceNumber === undefined || state.lastSequenceNumber === undefined
				? ""
				: `, sequence ${state.firstSequenceNumber}..${state.lastSequenceNumber}`;
		return {
			message: `Interrupted OpenAI Codex response after ${state.consecutiveEvents} consecutive whitespace-only tool-call argument delta events (${state.consecutiveChars} chars${sequenceLabel})${itemLabel}.`,
		};
	}

	handleToolCallArgumentsDelta(
		rawEvent: Record<string, unknown>,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		const delta = (rawEvent as { delta?: string }).delta || "";
		// Observe BEFORE the item/block guard: degenerate whitespace frames can keep
		// arriving after the item closed (entry detached) and still count as
		// progress for the idle watchdogs — dropping them unobserved would reopen
		// the infinite-loop hole the breaker exists for.
		const interruption = this.observeWhitespaceToolCallArgumentsDelta(rawEvent, delta);
		if (interruption) return interruption;
		// Route to the entry the event keys to; a delta whose item already closed
		// is dropped instead of leaking into a sibling tool call (#2619).
		const entry = this.openItemForEvent(rawEvent);
		if (!entry) return undefined;
		if (entry.item.type !== "function_call" || entry.block?.type !== "toolCall") return undefined;
		accumulateToolCallArgumentsDelta(entry.block, delta, stream, output, entry.contentIndex);
		return undefined;
	}

	handleToolCallArgumentsDone(rawEvent: Record<string, unknown>): void {
		const entry = this.openItemForEvent(rawEvent);
		if (entry?.item.type !== "function_call" || entry.block?.type !== "toolCall") return;
		const args = (rawEvent as { arguments?: string }).arguments;
		if (typeof args === "string") finalizeToolCallArgumentsDone(entry.block, args);
	}

	handleCustomToolCallInputDelta(
		rawEvent: Record<string, unknown>,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		const delta = (rawEvent as { delta?: string }).delta || "";
		// Observe BEFORE the item/block guard — see handleToolCallArgumentsDelta.
		const interruption = this.observeWhitespaceToolCallArgumentsDelta(rawEvent, delta);
		if (interruption) return interruption;
		const entry = this.openItemForEvent(rawEvent);
		if (!entry) return undefined;
		if (entry.item.type !== "custom_tool_call" || entry.block?.type !== "toolCall") return undefined;
		accumulateCustomToolCallInputDelta(entry.block, delta, stream, output, entry.contentIndex);
		return undefined;
	}

	handleCustomToolCallInputDone(rawEvent: Record<string, unknown>): void {
		const entry = this.openItemForEvent(rawEvent);
		if (entry?.item.type !== "custom_tool_call" || entry.block?.type !== "toolCall") return;
		const input = (rawEvent as { input?: string }).input;
		if (typeof input === "string") finalizeCustomToolCallInputDone(entry.block, input);
	}
}

interface CodexWhitespaceToolCallArgumentsDeltaState {
	itemId: string;
	outputIndex?: number;
	consecutiveEvents: number;
	consecutiveChars: number;
	firstSequenceNumber?: number;
	lastSequenceNumber?: number;
}

interface CodexWhitespaceToolCallArgumentsDeltaInterruption {
	message: string;
}

interface CodexStreamFailureContext {
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	options: OpenAICodexResponsesOptions | undefined;
	requestContext: CodexRequestContext;
	runtime?: CodexStreamRuntime;
	startTime: number;
	firstTokenTime?: number;
}

interface CodexStreamCompletion {
	firstTokenTime?: number;
}

function isCodexWebSocketRetryableStreamError(error: unknown): boolean {
	if (!(error instanceof CodexWebSocketTransportError)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes("websocket closed (") ||
		message.includes("websocket closed before response completion") ||
		message.includes("websocket connection is unavailable") ||
		message.includes("websocket send failed") ||
		message.includes("websocket ping failed") ||
		message.includes("websocket pong timeout") ||
		message.includes("websocket message queue exceeded") ||
		message.includes("websocket request already in progress") ||
		message.includes("idle timeout waiting for websocket") ||
		message.includes("timeout waiting for first websocket event") ||
		message.includes("syntaxerror") ||
		message.includes("json")
	);
}

function updateCodexSessionMetadataFromHeaders(
	turnState: CodexTurnStateCell | undefined,
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if ((!turnState && !state) || !headers) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const responseTurnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState && turnState.value === undefined && responseTurnState && responseTurnState.length > 0) {
		turnState.value = responseTurnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (state && modelsEtag && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
}

/** @internal Exported for tests. */
export function normalizeCodexToolChoice(
	choice: ToolChoice | undefined,
	tools: Tool[] = [],
	model?: Model<"openai-codex-responses">,
): string | Record<string, unknown> | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	const allowFreeform = model ? model.applyPatchToolType === "freeform" : false;
	const mapName = (name: string): Record<string, string> | undefined => {
		const directTool = tools.find(tool => tool.name === name);
		const customTool = allowFreeform
			? tools.find(tool => tool.customFormat && (tool.name === name || tool.customWireName === name))
			: undefined;
		const offeredTool = customTool ?? directTool;
		if (!offeredTool) return undefined;
		if (offeredTool.native?.type === "computer" && model?.supportsComputerUse === true) {
			return { type: "computer" };
		}
		return customTool
			? { type: "custom", name: customTool.customWireName ?? customTool.name }
			: { type: "function", name: offeredTool.name };
	};
	if (choice.type === "computer") {
		const computer = tools.find(tool => tool.native?.type === "computer");
		if (!computer) return undefined;
		return model?.supportsComputerUse === true ? { type: "computer" } : { type: "function", name: computer.name };
	}
	if (choice.type === "function") {
		if ("function" in choice && choice.function?.name) {
			return mapName(choice.function.name);
		}
		if ("name" in choice && choice.name) {
			return mapName(choice.name);
		}
	}
	if (choice.type === "tool" && choice.name) {
		return mapName(choice.name);
	}
	return undefined;
}
function unrollCodexComputerItems(items: ResponseInput, supportsImageDetailOriginal: boolean): ResponseInput {
	const replayItems = stripOpenAIResponsesComputerLinkedReasoningIdsForReplay(items);
	const unrolled: ResponseInput = [];
	for (const item of replayItems) {
		if (item.type === "computer_call") {
			const actions = item.actions ?? (item.action ? [item.action] : []);
			unrolled.push({
				type: "function_call",
				call_id: item.call_id,
				name: "computer",
				arguments: JSON.stringify({ actions }),
				status: item.status,
			});
			continue;
		}
		if (item.type === "computer_call_output") {
			const image =
				typeof item.output.image_url === "string" && item.output.image_url.length > 0
					? ({
							type: "input_image",
							detail: supportsImageDetailOriginal ? "original" : "auto",
							image_url: item.output.image_url,
						} satisfies ResponseInputContent)
					: typeof item.output.file_id === "string" && item.output.file_id.length > 0
						? ({
								type: "input_image",
								detail: supportsImageDetailOriginal ? "original" : "auto",
								file_id: item.output.file_id,
							} satisfies ResponseInputContent)
						: undefined;
			unrolled.push({
				type: "function_call_output",
				call_id: item.call_id,
				output: image ? "(see attached image)" : "",
			});
			if (image) {
				unrolled.push({
					role: "user",
					content: [{ type: "input_text", text: "Attached image from computer tool result:" }, image],
				});
			}
			continue;
		}
		unrolled.push(item);
	}
	return unrolled;
}

function unrollCodexComputerAssistantMessage(message: AssistantMessage): AssistantMessage {
	let changed = false;
	const content = message.content.map(block => {
		if (block.type !== "toolCall" || block.providerMetadata?.type !== "computer") return block;
		changed = true;
		const call: ToolCall = {
			...block,
			arguments: { actions: structuredCloneJSON(block.providerMetadata.actions) },
		};
		delete call.providerMetadata;
		return call;
	});
	return changed ? { ...message, content } : message;
}

function unrollCodexComputerToolResult(message: ToolResultMessage): ToolResultMessage {
	if (message.providerMetadata?.type !== "computer") return message;
	const result: ToolResultMessage = { ...message };
	delete result.providerMetadata;
	return result;
}

function getCodexServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "serviceTierCost">,
	serviceTier: ServiceTier | "default" | undefined,
): number {
	// The subscription route draws on included plan usage, so its cost is the
	// usage-equivalent: each tier's multiplier comes from the catalog table, which
	// uses OpenAI's included-usage rates (GPT-6 Astra: Fast 2.5x, Ultrafast 8x;
	// GPT-6.2: Fast 2x, Ultrafast 6x). A tier with no entry stays at 1x rather
	// than an invented multiplier.
	if (serviceTier !== "flex" && serviceTier !== "priority" && serviceTier !== "ultrafast") return 1;
	return model.serviceTierCost?.[serviceTier] ?? 1;
}

/**
 * The tier a Codex turn was served at. The Codex backend echoes
 * `service_tier: "default"` on turns it serves at the sent tier (a `priority`
 * turn decodes at Fast speed yet reports `default`), so a `default` or `auto`
 * echo carries no information and, like an absent one, resolves to the sent
 * tier, or `default` when none was sent. Any other echo (`flex`, `priority`,
 * `ultrafast`, `scale`) is authoritative. The tier's identity is preserved even
 * when it has no pricing entry (`scale`), because the recorded tier also drives
 * premium-request and speed accounting. The echo cannot reveal a genuine
 * downgrade, so a downgraded turn is recorded at the sent tier.
 */
function resolveCodexCostServiceTier(res: ServiceTier | undefined, req?: unknown): ServiceTier {
	if (res !== undefined && res !== "default" && res !== "auto") return res;
	return parseServiceTier(req) ?? "default";
}

function applyCodexServiceTierPricing(
	model: Pick<Model<"openai-codex-responses">, "provider" | "api" | "identity" | "serviceTierCost">,
	usage: AssistantMessage["usage"],
	resTier: ServiceTier | undefined,
	reqTier: unknown,
): ServiceTier {
	const resolvedTier = resolveCodexCostServiceTier(resTier, reqTier) ?? "default";
	usage.premiumRequests ??= getPremiumServiceTierRequests(resolvedTier, model, { served: true });
	const multiplier = getCodexServiceTierCostMultiplier(model, resolvedTier);
	if (multiplier === 1) return resolvedTier;
	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return resolvedTier;
}

function resetOutputState(output: AssistantMessage): void {
	output.content.length = 0;
	output.usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	output.stopReason = "stop";
	output.stopDetails = undefined;
}

function createRequestSetup(options: OpenAICodexResponsesOptions | undefined): CodexRequestSetup {
	const requestAbortController = new AbortController();
	const requestSignal = options?.signal
		? AbortSignal.any([options.signal, requestAbortController.signal])
		: requestAbortController.signal;
	const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
	const websocketIdleTimeoutMs = options?.streamIdleTimeoutMs ?? CODEX_WEBSOCKET_IDLE_TIMEOUT_MS;
	const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
	const websocketFirstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS;
	const wrapCodexSseStream = (
		source: AsyncGenerator<Record<string, unknown>>,
	): AsyncGenerator<Record<string, unknown>> =>
		iterateWithIdleTimeout(source, {
			idleTimeoutMs,
			firstItemTimeoutMs: firstEventTimeoutMs,
			firstItemErrorMessage: "OpenAI Codex SSE stream timed out while waiting for the first event",
			errorMessage: "OpenAI Codex SSE stream stalled while waiting for the next event",
			onIdle: () => requestAbortController.abort(),
			onFirstItemTimeout: () => requestAbortController.abort(),
			abortSignal: options?.signal,
			isProgressItem: isResponsesWebSocketProgressEvent,
		});
	return {
		requestAbortController,
		requestSignal,
		wrapCodexSseStream,
		firstEventTimeoutMs,
		websocketIdleTimeoutMs,
		websocketFirstEventTimeoutMs,
	};
}

function createCodexRequestContext(
	model: Model<"openai-codex-responses">,
	transformedBody: RequestBody,
	options: OpenAICodexResponsesOptions | undefined,
	contextOptions: {
		isolateCompactionTransport: boolean;
		startNewTurn?: boolean;
		turnStartedAtUnixMs?: number;
	},
): CodexRequestContext {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
	if (!apiKey) {
		throw new AIError.MissingApiKeyError(model.provider);
	}

	const accountId = getCodexAccountId(apiKey);
	applyCodexAccessPrograms(transformedBody, model, accountId, options?.codexAccessPrograms);
	const baseUrl = model.baseUrl || CODEX_BASE_URL;
	const url = resolveCodexResponsesUrl(baseUrl);

	const transportSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const codexClientVersion = getCodexClientVersion();
	const requestHeaders = { ...model.headers, ...options?.headers };
	const rawRequestDump: RawHttpRequestDump = {
		provider: model.provider,
		api: model.api,
		model: model.id,
		method: "POST",
		url,
		body: transformedBody,
	};

	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const isolatedTransportState =
		contextOptions.isolateCompactionTransport && options?.codexCompaction
			? createCodexProviderSessionState()
			: undefined;
	const transportProviderSessionState = isolatedTransportState ?? providerSessionState;
	const responsesLite = resolveCodexResponsesLite(options?.responsesLite);
	const sessionKey = getCodexWebSocketSessionKey(transportSessionId, model, accountId, apiKey, baseUrl, responsesLite);
	const publicSessionKey = transportSessionId ? `${baseUrl}:${model.id}:${transportSessionId}` : undefined;
	if (sessionKey && publicSessionKey) {
		transportProviderSessionState?.webSocketPublicToPrivate.set(publicSessionKey, sessionKey);
	}
	const sharedWebsocketState =
		sessionKey && transportSessionId && providerSessionState
			? isolatedTransportState
				? providerSessionState.webSocketSessions.get(sessionKey)
				: getCodexWebSocketSessionState(sessionKey, transportSessionId, providerSessionState)
			: undefined;
	const websocketState =
		sessionKey && transportSessionId && isolatedTransportState
			? getCodexWebSocketSessionState(sessionKey, transportSessionId, isolatedTransportState)
			: sharedWebsocketState;
	if (isolatedTransportState && websocketState && sharedWebsocketState) {
		websocketState.disableWebsocket = sharedWebsocketState.disableWebsocket;
		websocketState.modelsEtag = sharedWebsocketState.modelsEtag;
	}
	const metadataSessionId = transportSessionId ?? crypto.randomUUID();
	const metadataSession = getOrCreateCodexMetadataSessionState(metadataSessionId, providerSessionState);
	const compaction = options?.codexCompaction;
	const requestKind: OpenAICodexRequestKind = compaction ? "compaction" : "turn";
	const startNewTurn = resolveCodexStartNewTurn(metadataSession, requestKind, compaction, contextOptions.startNewTurn);
	const standaloneCompaction = compaction?.phase === "standalone_turn";
	clearCodexTurnStatesForNewTurn(metadataSession, startNewTurn, compaction);
	// Standalone compaction owns a throwaway turn. Every live cell is isolated by
	// the same credential/backend/model/Lite key as its transport session.
	const turnState = standaloneCompaction ? {} : getOrCreateCodexTurnState(metadataSession, sessionKey);
	const requestMetadata = createCodexRequestMetadata(metadataSession, requestKind, {
		startNewTurn,
		turnStartedAtUnixMs: compaction
			? startNewTurn || !metadataSession.turnId
				? Date.now()
				: undefined
			: contextOptions.turnStartedAtUnixMs,
		clientMetadata: transformedBody.client_metadata,
		parentTurnId: options?.parentTurnId,
		compaction,
		affinitySessionId: normalizeOpenAIPromptCacheKey(options?.parentSessionId),
	});
	transformedBody.client_metadata = requestMetadata.clientMetadata;
	return {
		apiKey,
		accountId,
		baseUrl,
		url,
		requestHeaders,
		transportSessionId,
		providerSessionState,
		isolatedTransportState,
		websocketState,
		turnState,
		responsesLite,
		requestMetadata,
		codexClientVersion,
		transformedBody,
		rawRequestDump,
	};
}

async function buildCodexRequestContext(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
): Promise<CodexRequestContext> {
	const promptCacheKey = getOpenAIPromptCacheKey(options);
	const transformedBody = await buildTransformedCodexRequestBody(model, context, options, promptCacheKey);
	return createCodexRequestContext(model, transformedBody, options, {
		isolateCompactionTransport: true,
		startNewTurn: options?.codexCompaction ? undefined : !isCodexWithinTurnContinuation(context),
		turnStartedAtUnixMs: options?.codexCompaction ? undefined : getCodexTurnStartedAtUnixMs(context),
	});
}

/**
 * Codex reasoning controls for the caller's request. `forceReasoningOff` always
 * sends the `none` tier. `disableReasoning` follows the catalog disable mode:
 * `none` where the model accepts it, else the lowest supported effort —
 * omitting effort would let the backend apply its default tier instead.
 */
function codexReasoningControls(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
): Pick<CodexRequestOptions, "reasoningEffort" | "reasoningOff"> {
	if (options?.forceReasoningOff) return { reasoningOff: true };
	if (!options?.disableReasoning) return { reasoningEffort: options?.reasoning };
	if (model.reasoning && model.compat.reasoningDisableMode === "none-effort") return { reasoningOff: true };
	return { reasoningEffort: getSupportedEfforts(model)[0] };
}

/** Serialize normal Codex turns and V2 compaction with the same cacheable prefix. */
export async function buildTransformedCodexRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options: OpenAICodexResponsesOptions | undefined,
	promptCacheKey = getOpenAIPromptCacheKey(options),
	inputPrefix?: InputItem[],
): Promise<RequestBody> {
	const input = convertMessages(model, context);
	const params: RequestBody = {
		model: model.requestModelId ?? model.id,
		input: inputPrefix?.length ? [...inputPrefix, ...input] : input,
		stream: true,
		prompt_cache_key: promptCacheKey,
	};

	// `maxTokens` is intentionally not forwarded: transformRequestBody strips
	// `max_output_tokens`/`max_completion_tokens` (the Codex backend rejects
	// caller-supplied output caps). Sampling controls (`temperature`, `top_p`,
	// `top_k`, `min_p`, `presence_penalty`, `repetition_penalty`,
	// `frequency_penalty`, `stop`) are likewise refused with
	// `{"detail":"Unsupported parameter: temperature"}` etc., so we drop
	// everything from `StreamOptions` rather than forwarding any of them.
	// (#3117 — codex-rs sends none of these either.)
	applyOpenAIServiceTier(params, options?.serviceTier, model);
	const hasDeclaredTools = (context.tools?.length ?? 0) > 0;
	if (hasDeclaredTools) {
		params.tools = convertOpenAICodexResponsesTools(context.tools ?? [], model);
	}
	// Native `additional_tools` items never land in `context.tools`, but they still
	// reach the upstream. A caller constraint has to travel with them.
	const hasNativeAdditionalTools =
		Array.isArray(params.input) && params.input.some(item => item.type === "additional_tools");
	if (options?.toolChoice && (hasDeclaredTools || hasNativeAdditionalTools)) {
		const toolChoice = normalizeCodexToolChoice(options.toolChoice, context.tools ?? [], model);
		if (toolChoice) params.tool_choice = toolChoice;
	}

	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	if (systemPrompts.length > 0) {
		params.instructions = systemPrompts[0];
	}
	const developerMessages = systemPrompts.slice(1);
	if (options?.clientMetadata && Object.keys(options.clientMetadata).length > 0) {
		params.client_metadata = { ...options.clientMetadata };
	}
	const codexOptions: CodexRequestOptions = {
		...codexReasoningControls(model, options),
		reasoningSummary: options?.reasoningSummary,
		reasoningContext: options?.reasoningContext,
		textVerbosity: options?.textVerbosity,
		include: options?.include,
		responsesLite: options?.responsesLite,
	};

	const body = await transformRequestBody(params, model, codexOptions, { developerMessages });
	applyCodexStableEffort(model, body, options);
	return body;
}

/**
 * Keep the request-level effort byte-stable across a conversation and carry
 * later changes as `configuration_update` items (GPT-6 family). Requires a
 * session id and provider session state to remember the baseline; without
 * them every request stands alone and sends its own effort.
 */
function applyCodexStableEffort(
	model: Model<"openai-codex-responses">,
	body: RequestBody,
	options: OpenAICodexResponsesOptions | undefined,
): void {
	if (!model.compat.supportsConfigurationUpdate || options?.codexCompaction) return;
	const effort = body.reasoning?.effort;
	if (effort === undefined || effort === "none" || !body.input) return;
	const providerState = getCodexProviderSessionState(options?.providerSessionState);
	const sessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	if (!providerState || !sessionId) return;
	const state = resolveOpenAIEffortControlState(
		providerState.effortControls,
		id => `${model.id}\u0000${id}`,
		sessionId,
		normalizeOpenAIPromptCacheKey(options?.parentSessionId),
	);
	const lowest = options?.minimizeEffort ? lowestCodexWireEffort(model) : undefined;
	body.reasoning = {
		...body.reasoning,
		effort: planStableOpenAIEffort(state, body.input, effort, lowest === "none" ? undefined : lowest),
	};
}

async function openInitialCodexEventStream(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	const { transformedBody, websocketState } = requestContext;
	if (websocketState && shouldUseCodexWebSocket(model, websocketState, options?.preferWebsockets)) {
		const websocketRetryBudget = CODEX_WEBSOCKET_RETRY_BUDGET;
		let websocketRetries = 0;
		while (true) {
			try {
				return await openCodexWebSocketTransport(
					model,
					options,
					requestContext,
					requestSetup,
					websocketState,
					websocketRetries,
					options ? event => options.onSseEvent?.(event, model) : undefined,
				);
			} catch (error) {
				if (!(error instanceof CodexWebSocketTransportError)) throw error;
				// Another request owns the shared socket: send this one over SSE and
				// leave the socket and session state to that request.
				if (error instanceof CodexWebSocketBusyError) break;
				const fatalWebSocketMessage = error.message.toLowerCase();
				const isFatal = CODEX_WEBSOCKET_FATAL_PATTERNS.some(pattern =>
					fatalWebSocketMessage.includes(pattern.toLowerCase()),
				);
				const activateFallback = isFatal || websocketRetries >= websocketRetryBudget;
				recordCodexWebSocketFailure(websocketState, activateFallback);
				CODEX_DEBUG &&
					logger.debug("[codex] codex websocket fallback", {
						error: error.message,
						retry: websocketRetries,
						retryBudget: websocketRetryBudget,
						activated: activateFallback,
						fatal: isFatal,
					});
				if (!activateFallback) {
					websocketRetries += 1;
					await scheduler.wait(CODEX_WEBSOCKET_RETRY_DELAY_MS * Math.max(1, websocketRetries), {
						signal: requestSetup.requestSignal,
					});
					continue;
				}
				break;
			}
		}
	} else if (websocketState) {
		releaseIdleCodexWebSocket(websocketState);
	}
	try {
		return await openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
	} catch (error) {
		if (!dropRejectedCodexAccessPrograms(transformedBody, model, requestContext.accountId, error)) throw error;
		return openCodexSseTransport(model, requestContext, requestSetup, options, websocketState, transformedBody);
	}
}

function toCodexRequestBody(body: OpenAICodexCompactionBody): RequestBody {
	const request: RequestBody = { model: body.model };
	for (const key in body) {
		if (key !== "model") request[key] = body[key];
	}
	return request;
}

/**
 * Open a provider-native V2 compaction stream through Codex's WebSocket-first
 * transport, replaying WebSocket transport failures over SSE.
 */
export async function openCodexCompactionEventStream(
	model: Model<"openai-codex-responses">,
	body: OpenAICodexCompactionBody,
	options: OpenAICodexCompactionStreamOptions,
): Promise<AsyncGenerator<Record<string, unknown>>> {
	const requestSetup = createRequestSetup(options);
	let requestContext: CodexRequestContext;
	let initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
	};
	try {
		requestContext = createCodexRequestContext(model, toCodexRequestBody(body), options, {
			isolateCompactionTransport: false,
		});
		initial = await openInitialCodexEventStream(model, options, requestSetup, requestContext);
	} catch (error) {
		requestSetup.requestAbortController.abort();
		throw error;
	}

	if (requestContext.websocketState) {
		requestContext.websocketState.lastTransport = initial.transport;
		// The compaction request may use the existing append baseline, but the
		// replacement history makes that baseline stale for the next normal turn.
		resetCodexWebSocketAppendState(requestContext.websocketState);
	}
	return streamCodexCompactionEvents(model, options, requestSetup, requestContext, initial);
}

async function* streamCodexCompactionEvents(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexCompactionStreamOptions,
	requestSetup: CodexRequestSetup,
	requestContext: CodexRequestContext,
	initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
	},
): AsyncGenerator<Record<string, unknown>> {
	let completed = false;
	const websocketState = requestContext.websocketState;
	const previousTurnState = requestContext.turnState.value;
	const previousModelsEtag = websocketState?.modelsEtag;
	try {
		if (initial.transport === "websocket") {
			// Do not expose a WebSocket attempt until it finishes: an SSE replay
			// must replace, not extend, any partial compaction output.
			const bufferedEvents: Array<Record<string, unknown>> = [];
			try {
				for await (const event of initial.eventStream) bufferedEvents.push(event);
			} catch (error) {
				if (options.signal?.aborted || !(error instanceof CodexWebSocketTransportError)) {
					throw error;
				}
				const state = requestContext.websocketState;
				if (state && !(error instanceof CodexWebSocketBusyError)) recordCodexWebSocketFailure(state, true);
				const fallback = await openCodexSseTransport(model, requestContext, requestSetup, options, state);
				if (state) state.lastTransport = fallback.transport;
				yield* drainCodexCompactionEvents(fallback.eventStream, requestContext);
				completed = true;
				return;
			}
			const failure = bufferedEvents.findLast(event => event.type === "error" || event.type === "response.failed");
			if (
				failure !== undefined &&
				dropRejectedCodexAccessPrograms(
					requestContext.transformedBody,
					model,
					requestContext.accountId,
					createCodexProviderStreamError(failure),
				)
			) {
				const replay = await openCodexSseTransport(model, requestContext, requestSetup, options, websocketState);
				if (websocketState) websocketState.lastTransport = replay.transport;
				yield* drainCodexCompactionEvents(replay.eventStream, requestContext);
				completed = true;
				return;
			}
			// Apply metadata only once the WebSocket attempt succeeded: a discarded
			// attempt must not leak its `x-codex-turn-state` into the session.
			for (const event of bufferedEvents) {
				applyCodexCompactionResponseMetadata(requestContext, event);
				yield event;
			}
		} else {
			yield* drainCodexCompactionEvents(initial.eventStream, requestContext);
		}
		completed = true;
	} finally {
		if (!completed) {
			requestSetup.requestAbortController.abort();
			requestContext.turnState.value = previousTurnState;
			if (websocketState) websocketState.modelsEtag = previousModelsEtag;
		}
	}
}

/**
 * Capture `x-codex-turn-state`/`x-models-etag` response metadata after a
 * compaction attempt succeeds.
 */
function applyCodexCompactionResponseMetadata(
	requestContext: CodexRequestContext,
	event: Record<string, unknown>,
): void {
	if (event.type !== "response.metadata") return;
	updateCodexSessionMetadataFromHeaders(
		requestContext.turnState,
		requestContext.websocketState,
		toWebSocketHeaders(event.headers),
	);
}

async function* drainCodexCompactionEvents(
	events: AsyncGenerator<Record<string, unknown>>,
	requestContext: CodexRequestContext,
): AsyncGenerator<Record<string, unknown>> {
	for await (const event of events) {
		applyCodexCompactionResponseMetadata(requestContext, event);
		yield event;
	}
}
async function openCodexWebSocketTransport(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexResponsesOptions | undefined,
	requestContext: CodexRequestContext,
	requestSetup: CodexRequestSetup,
	websocketState: CodexWebSocketSessionState,
	retry: number,
	onSseEvent?: (event: RawSseEvent) => void,
): Promise<{
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
}> {
	let canAppendBeforeRequest = websocketState.canAppend === true;
	let chainedBody = buildCodexChainedRequestBody(requestContext.transformedBody, websocketState);
	const websocketHeaders = createCodexHeaders(
		requestContext.requestHeaders,
		requestContext.accountId,
		requestContext.apiKey,
		requestContext.codexClientVersion,
		requestContext.transportSessionId,
		"websocket",
		websocketState,
		requestContext.turnState,
		requestContext.responsesLite,
		requestContext.requestMetadata,
		await getCodexAttestationHeader(requestContext.accountId),
		requestContext.transformedBody,
	);
	// One socket carries one request at a time. While another request on this
	// session streams over it, reusing, replacing, or closing it would cut that
	// request off, so this one goes over SSE instead.
	if (websocketState.connection?.hasActiveRequest()) {
		throw new CodexWebSocketBusyError("websocket request already in progress");
	}
	// Accepted steering belongs to whichever request ends up owning the socket,
	// so it is only consumed once this request takes it (see `onOwned` below).
	const steered = websocketState.acceptedSteering;
	const onOwned = () => {
		if (websocketState.acceptedSteering === steered) websocketState.acceptedSteering = undefined;
	};
	let websocketConnection = await getOrCreateCodexWebSocketConnection(
		websocketState,
		requestContext.turnState,
		toWebSocketUrl(requestContext.url),
		websocketHeaders,
		model.provider,
		requestSetup.requestSignal,
	);
	let releaseReservation = websocketConnection.reserveForRequest();
	try {
		// Reconnecting (closed socket, idle eviction, token refresh, or routing-hint
		// change) resets `canAppend`; discard any delta built against the old socket.
		if (!websocketState.canAppend) {
			canAppendBeforeRequest = false;
			chainedBody = requestContext.transformedBody;
		}
		// Input the server already holds for a chained request (everything before
		// the delta); a hook that drops `previous_response_id` must resend it.
		const fullInput = requestContext.transformedBody.input ?? [];
		let chainCarriedInput: InputItem[] = chainedBody.previous_response_id
			? fullInput.slice(0, fullInput.length - (chainedBody.input?.length ?? 0))
			: [];
		const timeouts: CodexWebSocketRequestTimeouts = {
			idleTimeoutMs: requestSetup.websocketIdleTimeoutMs,
			firstEventTimeoutMs: requestSetup.websocketFirstEventTimeoutMs,
		};
		// Steering accepted for the previous response lives only on the socket that
		// accepted it; a replaced socket lost it, so the input is plain history.
		const steers = steered?.connection === websocketConnection ? steered.steers : [];
		const liveSteers = steers.filter(steer => !websocketConnection.hasFailedSteer([steer.id]));
		if (liveSteers.length > 0) {
			const plan = planSteeredRequest(
				chainedBody.previous_response_id ? chainedBody.input : undefined,
				liveSteers.flatMap(steer => steer.items),
			);
			if (plan.kind === "attach") {
				recordCodexTurnRequestDiagnostics(websocketState, chainedBody, "websocket", canAppendBeforeRequest);
				requestContext.rawRequestDump.body = chainedBody;
				return {
					eventStream: websocketConnection.streamRequest(
						{ attachSteerIds: liveSteers.map(steer => steer.id) },
						timeouts,
						requestSetup.requestSignal,
						onSseEvent,
						onOwned,
						releaseReservation,
					),
					requestBodyForState: cloneJsonTree(requestContext.transformedBody),
					transport: "websocket",
				};
			}
			if (plan.kind === "create") {
				// The server prepends the accepted steering itself; it is carried too.
				const delta = chainedBody.input ?? [];
				chainCarriedInput = [...chainCarriedInput, ...delta.filter(item => !plan.input.includes(item))];
				chainedBody = { ...chainedBody, input: plan.input };
			} else {
				// The server continues from input this request cannot line up with; a
				// fresh socket drops its queue and the full transcript carries the input.
				releaseReservation();
				websocketConnection.close("steering-discard");
				websocketState.connection = undefined;
				resetCodexWebSocketAppendState(websocketState);
				canAppendBeforeRequest = false;
				chainedBody = requestContext.transformedBody;
				websocketConnection = await getOrCreateCodexWebSocketConnection(
					websocketState,
					requestContext.turnState,
					toWebSocketUrl(requestContext.url),
					websocketHeaders,
					model.provider,
					requestSetup.requestSignal,
				);
				releaseReservation = websocketConnection.reserveForRequest();
			}
		}
		// WebSocket frames cannot carry per-request HTTP headers. Canonical Codex
		// request identity is already in `client_metadata`; connection-scoped
		// compatibility values that can change after the upgrade ride alongside it
		// on every `response.create`.
		const websocketClientMetadata = { ...chainedBody.client_metadata };
		if (requestContext.responsesLite) {
			websocketClientMetadata[CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY] = "true";
		}
		if (requestContext.turnState.value) {
			websocketClientMetadata[X_CODEX_TURN_STATE_HEADER] = requestContext.turnState.value;
		}
		let websocketRequest: RequestBody = {
			type: "response.create",
			...chainedBody,
			client_metadata: websocketClientMetadata,
		};
		const replacementWebsocketRequest = await options?.onPayload?.(websocketRequest, model);
		if (replacementWebsocketRequest !== undefined) {
			websocketRequest = replacementWebsocketRequest as RequestBody;
		}
		// The hook dropped the chain: the server no longer holds the chained
		// prefix, so the frame must carry it. An untouched delta becomes the full
		// transcript; a rewritten one keeps the hook's edits after that prefix.
		if (chainedBody.previous_response_id && !websocketRequest.previous_response_id) {
			websocketRequest.input = Bun.deepEquals(websocketRequest.input, chainedBody.input)
				? requestContext.transformedBody.input
				: [...chainCarriedInput, ...(websocketRequest.input ?? [])];
		}
		recordCodexTurnRequestDiagnostics(websocketState, websocketRequest, "websocket", canAppendBeforeRequest);
		const requestBodyForState = cloneJsonTree(requestContext.transformedBody);
		// `onPayload` may rewrite the outgoing frame (e.g. drop `stream_options` or
		// change `service_tier`); recorded state must reflect what was actually
		// sent — the sequential-cutoff summary decoder and the served-tier
		// fallback key off it.
		if (websocketRequest.stream_options === undefined) {
			delete requestBodyForState.stream_options;
		} else {
			requestBodyForState.stream_options = websocketRequest.stream_options;
		}
		if (websocketRequest.service_tier === undefined) {
			delete requestBodyForState.service_tier;
		} else {
			requestBodyForState.service_tier = websocketRequest.service_tier;
		}
		requestContext.rawRequestDump.body = websocketRequest;
		CODEX_DEBUG &&
			logger.debug("[codex] codex websocket request", {
				url: toWebSocketUrl(requestContext.url),
				model: requestContext.transformedBody.model,
				reasoningEffort: requestContext.transformedBody.reasoning?.effort ?? null,
				headers: redactHeaders(websocketHeaders),
				sentTurnStateHeader: websocketHeaders.has(X_CODEX_TURN_STATE_HEADER),
				sentModelsEtagHeader: websocketHeaders.has(X_MODELS_ETAG_HEADER),
				requestType: websocketRequest.type,
				retry,
				retryBudget: CODEX_WEBSOCKET_RETRY_BUDGET,
			});
		const eventStream = websocketConnection.streamRequest(
			{ send: withCodexRoutingFieldsFirst(websocketRequest) },
			timeouts,
			requestSetup.requestSignal,
			onSseEvent,
			onOwned,
			releaseReservation,
		);
		return {
			eventStream,
			requestBodyForState,
			transport: "websocket",
		};
	} catch (error) {
		releaseReservation();
		throw error;
	}
}

function getCodexTurnStartedAtUnixMs(context: Context): number {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i];
		if (message?.role === "user" && Number.isFinite(m