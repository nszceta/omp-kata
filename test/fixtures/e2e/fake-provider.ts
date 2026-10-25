/**
 * Scripted fake model provider for omp e2e tests. Loaded with `omp -e <this file>`.
 *
 * Env:
 *   OMP_FAKE_SCRIPT  path to a JSON script: { main: Step[], children?: { [name]: Step[] } }
 *   OMP_FAKE_LOG     path to a JSONL file; one line per provider request
 *
 * Agent selection: a child's first user message contains the marker `CHILD:<name>`
 * (put it in the `task` assignment); anything else is "main".
 * Step selection: step index == number of toolResult messages already in the context.
 * Past the end of a script the agent finishes with text "SCRIPT END".
 *
 * Steps:
 *   { bash: string }                              run a bash command
 *   { task: { name, assignment?, agent? } }       spawn subagent; assignment gets `CHILD:<name>` prepended
 *   { wait: true }                                `wait` tool (blocks for spawned jobs)
 *   { yield: true }                               subagent result submission
 *   { text: string }                              final assistant text
 */
import { createAssistantMessageEventStream } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { appendFileSync, readFileSync } from "node:fs";

export type Step =
	| { bash: string; timeout?: number }
	| { task: { name: string; assignment?: string; agent?: string } }
	| { wait: true }
	| { yield: true }
	| { text: string };

export interface Script {
	main: Step[];
	children?: Record<string, Step[]>;
}

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return JSON.stringify(content ?? "");
}

function pickStep(context: any): { agent: string; index: number; step: Step } {
	const script: Script = JSON.parse(readFileSync(process.env.OMP_FAKE_SCRIPT!, "utf8"));
	const msgs = context.messages as any[];
	const firstUser = msgs.find(m => m.role === "user");
	const match = /CHILD:([A-Za-z0-9_-]+)/.exec(textOf(firstUser?.content));
	const agent = match ? match[1]! : "main";
	const steps = (match ? script.children?.[agent] : script.main) ?? [];
	const index = msgs.filter(m => m.role === "toolResult").length;
	return { agent, index, step: steps[index] ?? { text: "SCRIPT END" } };
}

function toToolCall(step: Step): { name: string; arguments: Record<string, unknown> } | undefined {
	if ("bash" in step) return { name: "bash", arguments: { command: step.bash, ...(step.timeout ? { timeout: step.timeout } : {}) } };
	if ("task" in step) {
		const t = step.task;
		return {
			name: "task",
			arguments: { agent: t.agent ?? "task", task: `CHILD:${t.name}\n${t.assignment ?? "run your scripted steps"}`, solutionSpace: "scripted" },
		};
	}
	if ("wait" in step) return { name: "wait", arguments: {} };
	if ("yield" in step) return { name: "yield", arguments: { data: "scripted child done" } };
	return undefined;
}

let seq = 0;

export default function (pi: ExtensionAPI) {
	pi.registerProvider("fake", {
		baseUrl: "http://localhost:0",
		apiKey: "fake-key",
		api: "fake-api" as any,
		models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 8000 }],
		streamSimple(model, context: any) {
			const stream = createAssistantMessageEventStream();
			const base = { role: "assistant" as const, api: model.api, provider: model.provider, model: model.id, usage: zero, timestamp: Date.now() };
			const { agent, index, step } = pickStep(context);
			if (process.env.OMP_FAKE_LOG) {
				appendFileSync(
					process.env.OMP_FAKE_LOG,
					`${JSON.stringify({ seq: seq++, agent, index, step, systemPrompt: context.systemPrompt, messages: context.messages })}\n`,
				);
			}
			const call = toToolCall(step);
			queueMicrotask(() => {
				if (call) {
					const tc = { type: "toolCall", id: `call_${Math.random().toString(36).slice(2)}`, name: call.name, arguments: call.arguments };
					const msg: any = { ...base, content: [tc], stopReason: "toolUse" };
					stream.push({ type: "start", partial: { ...base, content: [], stopReason: "toolUse" } as any });
					stream.push({ type: "toolcall_start", contentIndex: 0, partial: msg });
					stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: tc as any, partial: msg });
					stream.push({ type: "done", reason: "toolUse", message: msg });
				} else {
					const text = (step as { text: string }).text;
					const msg: any = { ...base, content: [{ type: "text", text }], stopReason: "stop" };
					const empty: any = { ...base, content: [], stopReason: "stop" };
					stream.push({ type: "start", partial: empty });
					stream.push({ type: "text_start", contentIndex: 0, partial: { ...empty, content: [{ type: "text", text: "" }] } });
					stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: msg });
					stream.push({ type: "text_end", contentIndex: 0, content: text, partial: msg });
					stream.push({ type: "done", reason: "stop", message: msg });
				}
			});
			return stream;
		},
	});
}
