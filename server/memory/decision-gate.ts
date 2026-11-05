import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { privateRoutingBody } from "../openrouter.ts";
import { insertRun } from "../telemetry/store.ts";
import type { Gate } from "./extract.ts";

/**
 * Memory's gate on an OpenRouter decision model (the Decisions API): instead of writing
 * text, it answers the yes/no questions in gate.json with a probability, in about a
 * quarter of a second, and only its input is billed. `save` decides whether the writer
 * runs; `refuse` warns the writer that the turn holds something never to keep. The Seva
 * platform's benchmark chose Perplexity Decider V1.2. gate.json is read on every call.
 */
export const GATE_MODEL = process.env.PONDER_MEMORY_GATE_MODEL ?? "perplexity/pplx-decider-v1.2";
const QUESTIONS_PATH = new URL("./gate.json", import.meta.url);
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const THRESHOLD = 0.5;

export function readGateQuestions() {
	return readFile(QUESTIONS_PATH, "utf8");
}

type DecisionsResponse = {
	answers?: Record<string, { noul?: number }>;
	usage?: { cost?: number; input_tokens?: number; output_tokens?: number };
	error?: { message?: string };
};

export const decisionGate: Gate = async ({ scope, turn, existing }) => {
	const started = Date.now();
	// The turn is data: it goes in `state`, apart from the questions.
	const state = { saved_memories: existing.map((m) => m.text), person_said: turn.user, assistant_replied: turn.assistant };
	const response = await fetch(ENDPOINT, {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
		body: JSON.stringify({ model: GATE_MODEL, state, questions: JSON.parse(await readGateQuestions()), provider: privateRoutingBody }),
	});
	const body = (await response.json().catch(() => ({}))) as DecisionsResponse;
	const save = body.answers?.save?.noul;
	const refuse = body.answers?.refuse?.noul;
	if (!response.ok || typeof save !== "number") throw new Error(`Memory gate (${GATE_MODEL}): ${body.error?.message ?? `HTTP ${response.status}`}`);

	// Not a generateText call, so it is written to `runs` here, as telemetry writes the others. Credits count it.
	await insertRun({
		id: randomUUID(),
		parentId: null,
		threadId: scope.threadId,
		user: scope.userId ?? null,
		functionId: "memory-gate",
		model: GATE_MODEL,
		steps: 1,
		inputTokens: body.usage?.input_tokens ?? 0,
		outputTokens: body.usage?.output_tokens ?? 0,
		cachedTokens: 0,
		costUsd: body.usage?.cost ?? null,
		durationMs: Date.now() - started,
		toolCalls: [],
		finishReason: "stop",
	}).catch((error) => console.error("[memory] could not record the gate's run:", error));

	const refused = typeof refuse === "number" && refuse >= THRESHOLD;
	const pct = (p: number) => `${Math.round(p * 100)}%`;
	return {
		save: save >= THRESHOLD,
		reason: save >= THRESHOLD ? `Worth remembering (${pct(save)} sure)` : `Nothing lasting (${pct(1 - save)} sure)`,
		refuse: refused ? ["a secret, contact or ID details, health details, or details about another person"] : [],
		model: GATE_MODEL,
	};
};
