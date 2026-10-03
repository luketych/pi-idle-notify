import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATUS_VALUES = ["finished", "question", "error", "permission", "misc"] as const;
type NotifyStatus = (typeof STATUS_VALUES)[number];

type IdleNotifyConfig = {
	enabled?: boolean;
	title?: string;
	appName?: string;
	notifyCommand?: string;
	notifyArgs?: string[];
	soundPath?: string;
	soundByStatus?: Partial<Record<NotifyStatus, string>>;
	soundPlayer?: string;
	soundPlayerArgs?: string[];
	notifyOn?: NotifyStatus[];
	includePreview?: boolean;
	previewMaxLength?: number;
	minIntervalMs?: number;
};

type ResolvedNotifier = {
	command: string;
	buildArgs: (title: string, body: string, status: NotifyStatus) => string[];
};

type ResolvedPlayer = {
	command: string;
	buildArgs: (soundPath: string) => string[];
};

type ExtensionState = {
	config: IdleNotifyConfig;
	notifier: ResolvedNotifier | null;
	player: ResolvedPlayer | null;
	lastNotifyAt: number;
};

const DEFAULT_CONFIG: Required<
	Pick<IdleNotifyConfig, "enabled" | "title" | "notifyOn" | "includePreview" | "previewMaxLength" | "minIntervalMs">
> = {
	enabled: true,
	title: "Pi",
	notifyOn: [...STATUS_VALUES],
	includePreview: false,
	previewMaxLength: 160,
	minIntervalMs: 0,
};

const DEFAULT_SOUND_PLAYERS = ["mpv", "ffplay", "paplay", "aplay", "mpg123", "play", "cvlc", "afplay"];

const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const SUBAGENT_PARENT_SESSION_ENV = "PI_SUBAGENT_PARENT_SESSION";
const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";
const SUBAGENT_TEMP_ROOT_ENV = "PI_SUBAGENTS_TEMP_ROOT";
const SUBAGENT_ACTIVE_RUN_INDEX_DIR = ".active-runs";
const SUBAGENT_ASYNC_RUNS_DIR = "async-subagent-runs";
const SUBAGENT_ACTIVE_STATES = new Set(["queued", "running"]);

export type IdleNotifyRuntimeOptions = {
	env?: Record<string, string | undefined>;
};

export default function idleNotifyExtension(pi: ExtensionAPI) {
	createIdleNotifyRuntime(pi);
}

export function createIdleNotifyRuntime(pi: ExtensionAPI, options: IdleNotifyRuntimeOptions = {}) {
	const env = options.env ?? process.env;
	if (isSubagentChildProcess(env)) return;

	let state: ExtensionState | null = null;
	let notifyTimer: ReturnType<typeof setTimeout> | null = null;
	let currentSessionId: string | null = null;
	let currentSessionIsChild = false;
	let lastMessages: any[] = [];
	let subagentActivityGeneration = 0;
	const activeSubagents = new Map<string, string>();
	const completedSubagentEvents = new Set<string>();
	const eventUnsubscribes: Array<() => void> = [];

	const refreshState = (cwd: string, _hasUI: boolean) => {
		const config = normalizeConfig(loadConfig(cwd));
		const notifier = resolveNotifier(config);
		const player = resolvePlayer(config);
		state = {
			config,
			notifier,
			player,
			lastNotifyAt: 0,
		};
	};

	const clearPendingNotification = () => {
		if (!notifyTimer) return;
		clearTimeout(notifyTimer);
		notifyTimer = null;
	};

	const noteSubagentActivity = () => {
		subagentActivityGeneration += 1;
		clearPendingNotification();
	};

	const resetSubagentTracking = (ctx: any) => {
		clearPendingNotification();
		currentSessionId = getSubagentOwnerSessionId(ctx);
		currentSessionIsChild = isSubagentChildContext(ctx, env);
		lastMessages = [];
		activeSubagents.clear();
		completedSubagentEvents.clear();
		subagentActivityGeneration += 1;
		if (currentSessionIsChild || !currentSessionId) return;
		for (const id of snapshotActiveSubagentRunIds(currentSessionId, env)) {
			activeSubagents.set(id, currentSessionId);
		}
	};

	const isCurrentSessionPayload = (payload: any): payload is { sessionId: string } =>
		Boolean(currentSessionId && payload && typeof payload.sessionId === "string" && payload.sessionId === currentSessionId);

	const trackSubagentStarted = (payload: any) => {
		if (!isCurrentSessionPayload(payload)) return;
		const id = subagentPayloadId(payload);
		if (!id) return;
		const had = activeSubagents.has(id);
		activeSubagents.set(id, payload.sessionId);
		clearPendingNotification();
		if (!had) noteSubagentActivity();
	};

	const trackSubagentCompleted = (payload: any) => {
		if (!isCurrentSessionPayload(payload)) return;
		const id = subagentPayloadId(payload);
		if (!id) return;
		const completionKey = `${payload.sessionId}\0${id}`;
		const removed = activeSubagents.delete(id);
		const firstCompletion = !completedSubagentEvents.has(completionKey);
		completedSubagentEvents.add(completionKey);
		clearPendingNotification();
		if (removed || firstCompletion) noteSubagentActivity();
	};

	const hasBlockingSubagentWork = (ctx: any): boolean => {
		if (currentSessionIsChild || isSubagentChildContext(ctx, env)) return false;
		const sessionId = currentSessionId ?? getSubagentOwnerSessionId(ctx);
		if (!sessionId) return false;
		const active = new Set<string>();
		for (const [id, ownerSessionId] of activeSubagents) {
			if (ownerSessionId === sessionId) active.add(id);
		}
		for (const id of snapshotActiveSubagentRunIds(sessionId, env)) active.add(id);
		return active.size > 0;
	};

	const scheduleNotification = (messages: any[], ctx: any) => {
		if (currentSessionIsChild || isSubagentChildContext(ctx, env)) return;
		if (hasBlockingSubagentWork(ctx)) return;
		clearPendingNotification();
		const scheduledGeneration = subagentActivityGeneration;
		const scheduledSessionId = currentSessionId ?? getSubagentOwnerSessionId(ctx);
		notifyTimer = setTimeout(() => {
			void (async () => {
				notifyTimer = null;
				if (scheduledGeneration !== subagentActivityGeneration) return;
				if (scheduledSessionId && currentSessionId && scheduledSessionId !== currentSessionId) return;
				if (currentSessionIsChild || isSubagentChildContext(ctx, env)) return;
				if (hasBlockingSubagentWork(ctx)) return;
				if (!state) refreshState(ctx.cwd, ctx.hasUI);
				if (!state) return;

				const config = state.config;
				if (!config.enabled) return;
				if (ctx.hasPendingMessages?.() || (ctx.isIdle && !ctx.isIdle())) return;

				const now = Date.now();
				if (config.minIntervalMs && now - state.lastNotifyAt < config.minIntervalMs) return;

				const status = classifyStatus(messages);
				if (config.notifyOn && !config.notifyOn.includes(status)) return;

				const preview = config.includePreview ? buildPreview(messages, config.previewMaxLength) : "";
				const { title, body } = buildNotification(config, status, preview);

				await sendNotification(pi, state.notifier, title, body, status);
				await playSound(pi, state.player, config, status, ctx.cwd);

				state.lastNotifyAt = now;
			})();
		}, 0);
	};

	const subscribeSubagentEvent = (eventName: string, handler: (payload: unknown) => void) => {
		const events = (pi as { events?: { on?: (eventName: string, handler: (payload: unknown) => void) => (() => void) | void } }).events;
		if (typeof events?.on !== "function") return;
		const unsubscribe = events.on(eventName, handler);
		if (typeof unsubscribe === "function") eventUnsubscribes.push(unsubscribe);
	};

	subscribeSubagentEvent(SUBAGENT_ASYNC_STARTED_EVENT, trackSubagentStarted);
	subscribeSubagentEvent(SUBAGENT_ASYNC_COMPLETE_EVENT, trackSubagentCompleted);
	subscribeSubagentEvent(SUBAGENT_FOREGROUND_COMPLETE_EVENT, trackSubagentCompleted);

	pi.on("session_start", async (_event, ctx) => {
		refreshState(ctx.cwd, ctx.hasUI);
		resetSubagentTracking(ctx);
		if (!state || currentSessionIsChild) return;
		maybeWarnUser(state, ctx.hasUI, ctx);
	});

	pi.on("session_shutdown", async () => {
		clearPendingNotification();
		activeSubagents.clear();
		completedSubagentEvents.clear();
		currentSessionId = null;
		currentSessionIsChild = false;
		for (const unsubscribe of eventUnsubscribes.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// Best-effort cleanup during shutdown/reload.
			}
		}
	});

	pi.on("input", async () => {
		clearPendingNotification();
	});

	pi.on("agent_start", async () => {
		clearPendingNotification();
	});

	pi.on("tool_execution_start", async (event) => {
		if ((event as { toolName?: string }).toolName === "subagent") clearPendingNotification();
	});

	pi.on("agent_end", async (event) => {
		lastMessages = event.messages ?? [];
	});

	pi.on("agent_settled", async (_event, ctx) => {
		scheduleNotification(lastMessages, ctx);
	});
}

function isSubagentChildProcess(env: Record<string, string | undefined> = process.env): boolean {
	return env[SUBAGENT_CHILD_ENV] === "1";
}

export function isSubagentChildContext(ctx: any, env: Record<string, string | undefined> = process.env): boolean {
	if (isSubagentChildProcess(env)) return true;
	const parentSessionId = env[SUBAGENT_PARENT_SESSION_ENV];
	const currentSessionId = ctx?.sessionManager?.getSessionId?.();
	return Boolean(parentSessionId && currentSessionId && currentSessionId !== parentSessionId);
}

function getSubagentOwnerSessionId(ctx: any): string | null {
	const sessionFile = ctx?.sessionManager?.getSessionFile?.();
	if (typeof sessionFile === "string" && sessionFile) return sessionFile;
	const sessionId = ctx?.sessionManager?.getSessionId?.();
	return typeof sessionId === "string" && sessionId ? sessionId : null;
}

function subagentPayloadId(payload: any): string | null {
	for (const key of ["runId", "id"] as const) {
		const value = payload?.[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return null;
}

export function snapshotActiveSubagentRunIds(
	sessionId: string,
	env: Record<string, string | undefined> = process.env
): Set<string> {
	const ids = new Set<string>();
	const asyncRoot = resolveSubagentAsyncRoot(env);
	const indexed = readSubagentActiveIndex(asyncRoot);
	const candidates = indexed ?? readSubagentRunDirs(asyncRoot);
	for (const runId of candidates) {
		if (!isSafePathSegment(runId)) continue;
		const status = readSubagentStatus(path.join(asyncRoot, runId, "status.json"));
		if (!status || status.sessionId !== sessionId || !SUBAGENT_ACTIVE_STATES.has(status.state)) continue;
		ids.add(typeof status.runId === "string" && status.runId ? status.runId : runId);
	}
	return ids;
}

function resolveSubagentAsyncRoot(env: Record<string, string | undefined>): string {
	const configured = env[SUBAGENT_TEMP_ROOT_ENV]?.trim();
	const tempRoot = configured ? path.resolve(configured) : path.join(os.tmpdir(), `pi-subagents-${resolveTempScopeId(env)}`);
	return path.join(tempRoot, SUBAGENT_ASYNC_RUNS_DIR);
}

function resolveTempScopeId(env: Record<string, string | undefined>): string {
	if (typeof process.getuid === "function") return `uid-${process.getuid()}`;
	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}
	const home = env.USERPROFILE ?? env.HOME;
	if (home) return `home-${sanitizeTempScopeSegment(home)}`;
	try {
		const fallbackHome = os.homedir();
		if (fallbackHome) return `home-${sanitizeTempScopeSegment(fallbackHome)}`;
	} catch {
		// Fall through to shared scope.
	}
	return "shared";
}

function sanitizeTempScopeSegment(value: string): string {
	return value.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function readSubagentActiveIndex(asyncRoot: string): string[] | null {
	try {
		return fs.readdirSync(path.join(asyncRoot, SUBAGENT_ACTIVE_RUN_INDEX_DIR), { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return null;
		return [];
	}
}

function readSubagentRunDirs(asyncRoot: string): string[] {
	try {
		return fs.readdirSync(asyncRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name !== SUBAGENT_ACTIVE_RUN_INDEX_DIR && !entry.name.startsWith(".terminal"))
			.slice(0, 500)
			.map((entry) => entry.name);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return [];
		return [];
	}
}

function readSubagentStatus(statusPath: string): { runId?: string; sessionId?: string; state?: string } | null {
	try {
		const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
		if (!status || typeof status !== "object" || Array.isArray(status)) return null;
		return status as { runId?: string; sessionId?: string; state?: string };
	} catch {
		return null;
	}
}

function isSafePathSegment(value: string): boolean {
	return Boolean(value && value !== "." && value !== ".." && path.basename(value) === value && !value.includes(path.sep));
}

function maybeWarnUser(state: ExtensionState, hasUI: boolean, ctx: { ui?: any }) {
	if (!hasUI || !ctx.ui) return;
	if (state.config.enabled && !state.notifier) {
		ctx.ui.notify("idle-notify: No desktop notifier found (install notify-send or set idleNotify.notifyCommand).", "warning");
	}
	if (hasSoundConfigured(state.config) && !state.player) {
		ctx.ui.notify("idle-notify: Sound configured but no player found (install mpv/ffplay or set idleNotify.soundPlayer).", "warning");
	}
}

function hasSoundConfigured(config: IdleNotifyConfig): boolean {
	return Boolean(config.soundPath || (config.soundByStatus && Object.keys(config.soundByStatus).length > 0));
}

function normalizeConfig(config: IdleNotifyConfig): IdleNotifyConfig {
	const normalized: IdleNotifyConfig = {
		...DEFAULT_CONFIG,
		...config,
		soundByStatus: {
			...(config.soundByStatus ?? {}),
		},
	};

	if (config.notifyOn && Array.isArray(config.notifyOn)) {
		normalized.notifyOn = config.notifyOn.filter((status) => STATUS_VALUES.includes(status));
	}

	if (!normalized.notifyOn || normalized.notifyOn.length === 0) {
		normalized.notifyOn = [...STATUS_VALUES];
	}

	if (typeof normalized.previewMaxLength !== "number" || normalized.previewMaxLength <= 0) {
		normalized.previewMaxLength = DEFAULT_CONFIG.previewMaxLength;
	}

	if (typeof normalized.minIntervalMs !== "number" || normalized.minIntervalMs < 0) {
		normalized.minIntervalMs = DEFAULT_CONFIG.minIntervalMs;
	}

	return normalized;
}

function loadConfig(cwd: string): IdleNotifyConfig {
	const configDir = resolveConfigDir();
	const globalSettings = readJson(path.join(configDir, "settings.json"));
	const projectSettings = readJson(path.join(cwd, ".pi", "settings.json"));
	const globalConfig = globalSettings?.idleNotify ?? null;
	const projectConfig = projectSettings?.idleNotify ?? null;

	let merged = mergeConfig(DEFAULT_CONFIG, globalConfig);
	merged = mergeConfig(merged, projectConfig);
	return merged;
}

function mergeConfig(base: IdleNotifyConfig, override?: IdleNotifyConfig | null): IdleNotifyConfig {
	if (!override) return { ...base };
	return {
		...base,
		...override,
		notifyOn: override.notifyOn ?? base.notifyOn,
		notifyArgs: override.notifyArgs ?? base.notifyArgs,
		soundByStatus: { ...(base.soundByStatus ?? {}), ...(override.soundByStatus ?? {}) },
		soundPlayerArgs: override.soundPlayerArgs ?? base.soundPlayerArgs,
	};
}

function resolveConfigDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
}

function readJson(filePath: string): any | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function resolveNotifier(config: IdleNotifyConfig): ResolvedNotifier | null {
	if (config.notifyCommand) {
		const command = resolveCommand(config.notifyCommand);
		if (!command) return null;
		return {
			command,
			buildArgs: (title, body, status) =>
				applyTemplate(config.notifyArgs ?? ["{title}", "{body}"], { title, body, status }),
		};
	}

	if (process.platform === "linux") {
		const command = findExecutable("notify-send");
		if (!command) return null;
		return {
			command,
			buildArgs: (title, body, status) => {
				const urgency = status === "error" ? "critical" : status === "question" || status === "permission" ? "normal" : "low";
				return ["-a", config.appName ?? "pi", "--urgency", urgency, title, body];
			},
		};
	}

	if (process.platform === "darwin") {
		const command = findExecutable("osascript");
		if (!command) return null;
		return {
			command,
			buildArgs: (title, body) => {
				const safeTitle = escapeAppleScript(title);
				const safeBody = escapeAppleScript(body);
				return ["-e", `display notification \"${safeBody}\" with title \"${safeTitle}\"`];
			},
		};
	}

	if (process.platform === "win32") {
		const command = findExecutable("powershell.exe") ?? findExecutable("powershell");
		if (!command) return null;
		return {
			command,
			buildArgs: (title, body) => ["-NoProfile", "-Command", windowsToastScript(title, body)],
		};
	}

	return null;
}

function resolvePlayer(config: IdleNotifyConfig): ResolvedPlayer | null {
	if (config.soundPlayer) {
		const command = resolveCommand(config.soundPlayer);
		if (!command) return null;
		return {
			command,
			buildArgs: (soundPath) => buildSoundArgs(config.soundPlayerArgs, soundPath, command),
		};
	}

	for (const candidate of DEFAULT_SOUND_PLAYERS) {
		const command = findExecutable(candidate);
		if (!command) continue;
		return {
			command,
			buildArgs: (soundPath) => buildSoundArgs(undefined, soundPath, command),
		};
	}

	return null;
}

function resolveCommand(command: string): string | null {
	if (path.isAbsolute(command)) return fs.existsSync(command) ? command : null;
	const found = findExecutable(command);
	return found ?? null;
}

function buildSoundArgs(args: string[] | undefined, soundPath: string, player: string): string[] {
	const templateArgs = args ?? defaultArgsForPlayer(player);
	const replaced = applyTemplate(templateArgs, { soundPath });
	if (replaced.some((arg) => arg.includes(soundPath))) return replaced;
	return [...replaced, soundPath];
}

function defaultArgsForPlayer(player: string): string[] {
	const base = path.basename(player).toLowerCase();
	if (base.includes("mpv")) return ["--no-video", "--quiet", "{soundPath}"];
	if (base.includes("ffplay")) return ["-nodisp", "-autoexit", "-hide_banner", "-loglevel", "error", "{soundPath}"];
	if (base.includes("cvlc")) return ["--play-and-exit", "--quiet", "{soundPath}"];
	if (base.includes("mpg123")) return ["-q", "{soundPath}"];
	if (base.includes("afplay")) return ["{soundPath}"];
	if (base === "play") return ["-q", "{soundPath}"];
	return ["{soundPath}"];
}

function findExecutable(name: string): string | null {
	if (!name) return null;
	if (name.includes(path.sep) || name.includes("/")) {
		return fs.existsSync(name) ? name : null;
	}

	const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
	const extensions = process.platform === "win32"
		? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
		: [""];

	for (const entry of pathEntries) {
		for (const ext of extensions) {
			const fullPath = path.join(entry, `${name}${ext}`);
			if (fs.existsSync(fullPath)) return fullPath;
		}
	}

	return null;
}

function escapeAppleScript(input: string): string {
	return input.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function windowsToastScript(title: string, body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText02`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	return [
		`${mgr} > $null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		`$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${escapePowerShell(title)}')) > $null`,
		`$xml.GetElementsByTagName('text')[1].AppendChild($xml.CreateTextNode('${escapePowerShell(body)}')) > $null`,
		`[${type}.ToastNotificationManager]::CreateToastNotifier('${escapePowerShell(title)}').Show(${toast})`,
	].join("; ");
}

function escapePowerShell(input: string): string {
	return input.replace(/'/g, "''");
}

function applyTemplate(args: string[], variables: Record<string, string | undefined>): string[] {
	return args.map((arg) =>
		arg
			.replace(/\{title\}/g, variables.title ?? "")
			.replace(/\{body\}/g, variables.body ?? "")
			.replace(/\{status\}/g, variables.status ?? "")
			.replace(/\{soundPath\}/g, variables.soundPath ?? "")
	);
}

function classifyStatus(messages: any[]): NotifyStatus {
	const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
	const assistantText = extractText(assistant);
	const toolError = messages.some((message) => message?.role === "toolResult" && message?.isError);
	const stopReason = assistant?.stopReason ?? "";

	if (stopReason === "error" || toolError) return "error";
	if (matchesPermission(assistantText)) return "permission";
	if (matchesFinished(assistantText)) return "finished";
	if (matchesQuestion(assistantText)) return "question";
	return "misc";
}

function extractText(message: any): string {
	if (!message?.content) return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block: any) => block?.type === "text" && typeof block.text === "string")
		.map((block: any) => block.text)
		.join("\n")
		.trim();
}

function matchesPermission(text: string): boolean {
	const normalized = text.toLowerCase();
	return [
		"permission",
		"needs your approval",
		"need your approval",
		"need your permission",
		"allow me",
		"approve",
		"confirm",
		"proceed",
		"can i proceed",
		"should i proceed",
		"do you want me",
	].some((phrase) => normalized.includes(phrase));
}

function matchesFinished(text: string): boolean {
	const normalized = text.toLowerCase();
	return [
		"ready for review",
		"task complete",
		"task completed",
		"all set",
		"finished",
		"done",
		"ready to go",
	].some((phrase) => normalized.includes(phrase));
}

function matchesQuestion(text: string): boolean {
	if (!text) return false;
	if (text.includes("?")) return true;
	const normalized = text.toLowerCase();
	return ["can you", "could you", "would you", "do you", "please confirm", "let me know"].some((phrase) =>
		normalized.includes(phrase)
	);
}

function buildPreview(messages: any[], maxLength: number): string {
	const assistant = [...messages].reverse().find((message) => message?.role === "assistant");
	const text = extractText(assistant).replace(/\s+/g, " ").trim();
	if (!text) return "";
	if (text.length <= maxLength) return text;
	return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function buildNotification(config: IdleNotifyConfig, status: NotifyStatus, preview: string) {
	const title = config.title ?? DEFAULT_CONFIG.title;
	const label = status === "misc" ? "ready" : status;
	const bodyBase = `Ready for input (${label})`;
	const body = config.includePreview && preview ? `${bodyBase}\n${preview}` : bodyBase;
	return { title, body };
}

async function sendNotification(pi: ExtensionAPI, notifier: ResolvedNotifier | null, title: string, body: string, status: NotifyStatus) {
	if (!notifier) return;
	try {
		await pi.exec(notifier.command, notifier.buildArgs(title, body, status));
	} catch {
		return;
	}
}

async function playSound(
	pi: ExtensionAPI,
	player: ResolvedPlayer | null,
	config: IdleNotifyConfig,
	status: NotifyStatus,
	cwd: string
) {
	const soundPath = resolveSoundPath(config, status, cwd);
	if (!soundPath || !player) return;
	if (!fs.existsSync(soundPath)) return;

	try {
		await pi.exec(player.command, player.buildArgs(soundPath));
	} catch {
		return;
	}
}

function resolveSoundPath(config: IdleNotifyConfig, status: NotifyStatus, cwd: string): string | null {
	const override = config.soundByStatus?.[status];
	const soundPath = override ?? config.soundPath;
	if (!soundPath) return null;
	if (soundPath.startsWith("~")) return path.join(os.homedir(), soundPath.slice(1));
	if (path.isAbsolute(soundPath)) return soundPath;
	return path.resolve(cwd, soundPath);
}
