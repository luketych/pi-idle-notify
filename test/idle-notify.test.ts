import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIdleNotifyRuntime } from "../extensions/idle-notify/index.ts";

const DONE_MESSAGES = [{ role: "assistant", content: "Done" }];

class FakeEventBus {
	private handlers = new Map<string, Set<(payload: unknown) => void>>();

	on(eventName: string, handler: (payload: unknown) => void): () => void {
		let handlers = this.handlers.get(eventName);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(eventName, handlers);
		}
		handlers.add(handler);
		return () => handlers?.delete(handler);
	}

	emit(eventName: string, payload: unknown): void {
		for (const handler of [...(this.handlers.get(eventName) ?? [])]) handler(payload);
	}
}

class FakePi {
	readonly events?: FakeEventBus;
	readonly execCalls: Array<{ command: string; args: string[] }> = [];
	private handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();

	constructor(options: { events?: boolean } = { events: true }) {
		if (options.events !== false) this.events = new FakeEventBus();
	}

	on(eventName: string, handler: (event: any, ctx: any) => unknown): void {
		const handlers = this.handlers.get(eventName) ?? [];
		handlers.push(handler);
		this.handlers.set(eventName, handlers);
	}

	async emit(eventName: string, event: any, ctx: any): Promise<void> {
		for (const handler of this.handlers.get(eventName) ?? []) await handler(event, ctx);
	}

	async exec(command: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		this.execCalls.push({ command, args });
		return { stdout: "", stderr: "", exitCode: 0 };
	}
}

function makeCtx(input: {
	cwd: string;
	sessionFile?: string;
	sessionId?: string;
	pending?: boolean;
	idle?: boolean;
	hasUI?: boolean;
}) {
	let pending = input.pending ?? false;
	let idle = input.idle ?? true;
	return {
		cwd: input.cwd,
		hasUI: input.hasUI ?? true,
		ui: { notify() {} },
		sessionManager: {
			getSessionFile: () => input.sessionFile ?? null,
			getSessionId: () => input.sessionId ?? null,
		},
		hasPendingMessages: () => pending,
		isIdle: () => idle,
		setPending(value: boolean) { pending = value; },
		setIdle(value: boolean) { idle = value; },
	};
}

function ownerSessionId(ctx: ReturnType<typeof makeCtx>): string {
	return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId()!;
}

async function flushTimers(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

async function runParentTurn(pi: FakePi, ctx: ReturnType<typeof makeCtx>, messages = DONE_MESSAGES): Promise<void> {
	await pi.emit("agent_start", { type: "agent_start" }, ctx);
	await pi.emit("agent_end", { type: "agent_end", messages }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	await flushTimers();
}

function setup(t: Parameters<typeof test>[1], options: { sound?: boolean; events?: boolean } = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "idle-notify-test-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	const subagentTemp = path.join(root, "subagents");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	const notifyCommand = path.join(root, "notify-send-fake");
	fs.writeFileSync(notifyCommand, "#!/bin/sh\nexit 0\n");
	const config: any = {
		idleNotify: {
			enabled: true,
			notifyCommand,
			notifyArgs: ["{title}", "{body}", "{status}"],
			minIntervalMs: 0,
		},
	};
	if (options.sound) {
		const soundPlayer = path.join(root, "sound-player-fake");
		const soundPath = path.join(root, "sound.wav");
		fs.writeFileSync(soundPlayer, "#!/bin/sh\nexit 0\n");
		fs.writeFileSync(soundPath, "sound");
		config.idleNotify.soundPlayer = soundPlayer;
		config.idleNotify.soundPath = soundPath;
	}
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(config));

	const savedEnv = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_SUBAGENTS_TEMP_ROOT: process.env.PI_SUBAGENTS_TEMP_ROOT,
		PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
		PI_SUBAGENT_PARENT_SESSION: process.env.PI_SUBAGENT_PARENT_SESSION,
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PI_SUBAGENTS_TEMP_ROOT = subagentTemp;
	delete process.env.PI_SUBAGENT_CHILD;
	delete process.env.PI_SUBAGENT_PARENT_SESSION;

	const pi = new FakePi({ events: options.events });
	t.after(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(root, { recursive: true, force: true });
	});
	return { root, agentDir, projectDir, subagentTemp, pi, notifyCommand };
}

async function startSession(pi: FakePi, ctx: ReturnType<typeof makeCtx>): Promise<void> {
	await pi.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
}

function emitAsyncStarted(pi: FakePi, ctx: ReturnType<typeof makeCtx>, id: string): void {
	pi.events?.emit("subagent:async-started", { id, runId: id, sessionId: ownerSessionId(ctx), mode: "single", agent: "worker" });
}

function emitAsyncComplete(pi: FakePi, ctx: ReturnType<typeof makeCtx>, id: string, extra: Record<string, unknown> = {}): void {
	pi.events?.emit("subagent:async-complete", { id, runId: id, sessionId: ownerSessionId(ctx), success: true, state: "complete", ...extra });
}

test("ordinary parent turns still notify when settled and idle", async (t) => {
	const { pi, projectDir } = setup(t);
	createIdleNotifyRuntime(pi as any);
	const ctx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "parent.jsonl"), sessionId: "parent" });
	await startSession(pi, ctx);

	await runParentTurn(pi, ctx);

	assert.equal(pi.execCalls.length, 1);
	assert.equal(pi.execCalls[0]?.args[2], "finished");
});

test("multiple subagents finishing at different times stay silent until final parent response", async (t) => {
	const { pi, projectDir } = setup(t);
	createIdleNotifyRuntime(pi as any);
	const ctx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "parent.jsonl"), sessionId: "parent" });
	await startSession(pi, ctx);

	await pi.emit("agent_start", { type: "agent_start" }, ctx);
	emitAsyncStarted(pi, ctx, "run-a");
	emitAsyncStarted(pi, ctx, "run-b");
	await pi.emit("agent_end", { type: "agent_end", messages: DONE_MESSAGES }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	await flushTimers();
	assert.equal(pi.execCalls.length, 0);

	emitAsyncComplete(pi, ctx, "run-a");
	await flushTimers();
	assert.equal(pi.execCalls.length, 0);
	emitAsyncComplete(pi, ctx, "run-b");
	await flushTimers();
	assert.equal(pi.execCalls.length, 0);

	await runParentTurn(pi, ctx);
	assert.equal(pi.execCalls.length, 1);
});

test("last child completion before parent result processing cancels a scheduled notification", async (t) => {
	const { pi, projectDir } = setup(t);
	createIdleNotifyRuntime(pi as any);
	const ctx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "parent.jsonl"), sessionId: "parent" });
	await startSession(pi, ctx);

	await pi.emit("agent_end", { type: "agent_end", messages: DONE_MESSAGES }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	emitAsyncComplete(pi, ctx, "restored-run");
	await flushTimers();
	assert.equal(pi.execCalls.length, 0);

	await runParentTurn(pi, ctx);
	assert.equal(pi.execCalls.length, 1);
});

test("parent resumption while a notification is scheduled cancels the stale notification", async (t) => {
	const { pi, projectDir } = setup(t);
	createIdleNotifyRuntime(pi as any);
	const ctx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "parent.jsonl"), sessionId: "parent" });
	await startSession(pi, ctx);

	await pi.emit("agent_end", { type: "agent_end", messages: DONE_MESSAGES }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	await pi.emit("agent_start", { type: "agent_start" }, ctx);
	await flushTimers();
	assert.equal(pi.execCalls.length, 0);

	await pi.emit("agent_end", { type: "agent_end", messages: DONE_MESSAGES }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	await flushTimers();
	assert.equal(pi.execCalls.length, 1);
});

test("failed, cancelled, and duplicate subagent completions do not notify early", async (t) => {
	const { pi, projectDir } = setup(t);
	createIdleNotifyRuntime(pi as any);
	const ctx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "parent.jsonl"), sessionId: "parent" });
	await startSession(pi, ctx);

	emitAsyncStarted(pi, ctx, "run-a");
	emitAsyncStarted(pi, ctx, "run-b");
	await pi.emit("agent_end", { type: "agent_end", messages: DONE_MESSAGES }, ctx);
	await pi.emit("agent_settled", { type: "agent_settled" }, ctx);
	emitAsyncComplete(pi, ctx, "run-a", { success: false, state: "failed", error: "boom" });
	emitAsyncComplete(pi, ctx, "run-a", { success: false, state: "failed", error: "boom" });
	emitAsyncComplete(pi, ctx, "run-b", { success: false, state: "stopped", stopped: true });
	await flushTimers();
	assert.equal(pi.execCalls.length, 0);

	await runParentTurn(pi, ctx);
	assert.equal(pi.execCalls.length, 1);
});

test("child sessions produce no notification or sound", async (t) => {
	const child = setup(t, { sound: true });
	process.env.PI_SUBAGENT_CHILD = "1";
	createIdleNotifyRuntime(child.pi as any);
	const childCtx = makeCtx({ cwd: child.projectDir, sessionFile: path.join(child.projectDir, "child.jsonl"), sessionId: "child" });
	await startSession(child.pi, childCtx);
	await runParentTurn(child.pi, childCtx);
	assert.equal(child.pi.execCalls.length, 0);

	delete process.env.PI_SUBAGENT_CHILD;
	process.env.PI_SUBAGENT_PARENT_SESSION = "parent-session";
	const foreground = new FakePi();
	createIdleNotifyRuntime(foreground as any);
	const foregroundCtx = makeCtx({ cwd: child.projectDir, sessionFile: path.join(child.projectDir, "child2.jsonl"), sessionId: "child-session" });
	await startSession(foreground, foregroundCtx);
	await runParentTurn(foreground, foregroundCtx);
	assert.equal(foreground.execCalls.length, 0);
});

test("session shutdown and new session reset pending notifications and subagent state", async (t) => {
	const { projectDir } = setup(t);
	const firstPi = new FakePi();
	createIdleNotifyRuntime(firstPi as any);
	const firstCtx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "first.jsonl"), sessionId: "first" });
	await startSession(firstPi, firstCtx);
	emitAsyncStarted(firstPi, firstCtx, "old-run");
	await firstPi.emit("agent_end", { type: "agent_end", messages: DONE_MESSAGES }, firstCtx);
	await firstPi.emit("agent_settled", { type: "agent_settled" }, firstCtx);
	await firstPi.emit("session_shutdown", { type: "session_shutdown", reason: "reload" }, firstCtx);
	await flushTimers();
	assert.equal(firstPi.execCalls.length, 0);

	const secondPi = new FakePi();
	createIdleNotifyRuntime(secondPi as any);
	const secondCtx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "second.jsonl"), sessionId: "second" });
	await startSession(secondPi, secondCtx);
	await runParentTurn(secondPi, secondCtx);
	assert.equal(secondPi.execCalls.length, 1);
});

test("reload restores active subagent status from pi-subagents artifacts", async (t) => {
	const { pi, projectDir, subagentTemp } = setup(t);
	const ctx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "parent.jsonl"), sessionId: "parent" });
	const asyncRoot = path.join(subagentTemp, "async-subagent-runs");
	const runDir = path.join(asyncRoot, "restored-run");
	fs.mkdirSync(path.join(asyncRoot, ".active-runs"), { recursive: true });
	fs.mkdirSync(runDir, { recursive: true });
	fs.writeFileSync(path.join(asyncRoot, ".active-runs", "restored-run"), "");
	fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ runId: "restored-run", sessionId: ownerSessionId(ctx), state: "running" }));

	createIdleNotifyRuntime(pi as any);
	await startSession(pi, ctx);
	await runParentTurn(pi, ctx);
	assert.equal(pi.execCalls.length, 0);

	fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ runId: "restored-run", sessionId: ownerSessionId(ctx), state: "complete" }));
	fs.rmSync(path.join(asyncRoot, ".active-runs", "restored-run"), { force: true });
	emitAsyncComplete(pi, ctx, "restored-run");
	await runParentTurn(pi, ctx);
	assert.equal(pi.execCalls.length, 1);
});

test("ordinary behavior is unchanged without a subagent event bus", async (t) => {
	const { pi, projectDir } = setup(t, { events: false });
	createIdleNotifyRuntime(pi as any);
	const ctx = makeCtx({ cwd: projectDir, sessionFile: path.join(projectDir, "parent.jsonl"), sessionId: "parent" });
	await startSession(pi, ctx);

	await runParentTurn(pi, ctx);

	assert.equal(pi.execCalls.length, 1);
});
