import { readFile } from "node:fs/promises";
import { generateText, Output } from "ai";
import { z } from "zod";
import { privateRouting } from "../openrouter/OpenRouter.ts";
import * as OpenRouterKey from "../openrouter/OpenRouterKey.ts";
import { runPromise } from "../runtime/runtime.ts";
import { runTelemetry } from "../telemetry/Telemetry.ts";
import { decisionGate, GATE_MODEL, readGateQuestions } from "./decision-gate.ts";
import type { MemoryScope, MemoryTurn } from "./types.ts";

/**
 * What a finished turn adds to memory, in two steps. The gate (decision-gate.ts, its
 * questions in gate.json) decides whether there is anything to save, change or forget,
 * and whether the turn holds something never to keep; most turns stop there. Only on a
 * yes does the writer (extract.md) write the operations. The questions and the prompt
 * are read on every call, so an edit applies to the next turn without a restart. Every
 * decision, "nothing to save" included, is logged in `memory_saves`.
 */
const PROMPT_PATH = new URL("./extract.md", import.meta.url);
const MODEL = process.env.PONDER_MEMORY_MODEL ?? "z-ai/glm-5.3-flash";

export const KINDS = ["fact", "project", "preference"] as const;
export type MemoryKind = (typeof KINDS)[number];

/** A saved memory as the extractor sees it. */
export type ExistingMemory = { id: string; kind: MemoryKind; text: string };

/** An operation as code uses it. `quote` is the person's own words it rests on; postgres.ts checks it against the turn. */
export type Operation =
	| { op: "add"; kind: MemoryKind; text: string; quote: string; reason: string }
	| { op: "update"; id: string; text: string; quote: string; reason: string }
	| { op: "forget"; id: string; reason: string };

// One flat object for every operation: some providers OpenRouter routes to (Google's)
// reject the oneOf schema a union produces. Unused fields are empty strings.
const flatOperation = z.object({
	op: z.enum(["add", "update", "forget"]),
	id: z.string().describe('The memory to update or forget; "" for add'),
	kind: z.enum(KINDS).describe("For add; ignored otherwise"),
	text: z.string().describe('One standalone sentence, for add and update; "" for forget'),
	quote: z.string().describe('For add and update: the words in what the person said that the memory rests on, copied exactly; "" for forget'),
	reason: z.string(),
});

const decision = z.object({
	summary: z.string().describe("One short line: what you did and why"),
	operations: z.array(flatOperation),
});

export type Decision = { summary: string; operations: Operation[]; model: string };

/**
 * `existing` is the saved memories the turn may touch: all of them while there are few,
 * else the ones related to the turn. `forgotten` is what the person had Ponder forget, newest first.
 */
type ExtractInput = { scope: MemoryScope; turn: MemoryTurn; existing: ExistingMemory[]; forgotten?: string[] };
export type Extractor = (input: ExtractInput) => Promise<Decision>;

/** The gate's answer: run the writer or not, why, and what the turn holds that is never allowed. */
export type GateVerdict = { save: boolean; reason: string; refuse: string[]; model: string };
export type Gate = (input: ExtractInput) => Promise<GateVerdict>;
/** The writer, told what the gate found. */
export type Writer = (input: ExtractInput & { gate: GateVerdict }) => Promise<Decision>;

/** The gate's questions and the writer's prompt, as the Memory page shows them under "How it decides". */
export async function readExtractPrompt() {
	const [questions, extract] = await Promise.all([readGateQuestions(), readFile(PROMPT_PATH, "utf8")]);
	return (
		`# Step 1: the gate (${GATE_MODEL}, a decision model)\n\nIt answers these yes/no questions with a probability. Above 50% on "save", the writer runs.\n\n${questions.trim()}\n\n` +
		`# Step 2: the writer (${MODEL})\n\n${extract.trim()}\n`
	);
}

/** Gate first; the writer runs only on a yes. A no is logged with the gate's reason. */
export function gatedExtractor({ gate, write }: { gate: Gate; write: Writer }): Extractor {
	return async (input) => {
		const verdict = await gate(input);
		if (!verdict.save) {
			const refused = verdict.refuse.length ? ` Refused: ${verdict.refuse.join("; ")}.` : "";
			return { summary: `${verdict.reason}${refused}`, operations: [], model: verdict.model };
		}
		const decision = await write({ ...input, gate: verdict });
		return { ...decision, model: `${verdict.model} → ${decision.model}` };
	};
}

export const llmWriter: Writer = async ({ gate, ...input }) => {
	const note = [`The gate said: ${JSON.stringify(gate.reason)}`, gate.refuse.length ? `Never save: ${JSON.stringify(gate.refuse)}` : ""]
		.filter(Boolean)
		.join("\n");
	const { scope } = input;
	const { output } = await generateText({
		model: (await runPromise(OpenRouterKey.OpenRouterKey.use((key) => key.provider)))(MODEL, { usage: { include: true }, provider: privateRouting }),
		instructions: await readFile(PROMPT_PATH, "utf8"),
		prompt: `${describe(input)}\n\n${note}`,
		output: Output.object({ schema: decision }),
		...runTelemetry({ threadId: scope.threadId, user: scope.userId ?? "" }, "memory-extract"),
	});
	return { summary: output.summary, operations: toOperations(output.operations), model: MODEL };
};

/** The default: the gate, then the writer. */
export const llmExtractor: Extractor = gatedExtractor({ gate: decisionGate, write: llmWriter });

/**
 * Whether `quote` is in what the person said, ignoring case, spacing, the kind of quote
 * marks and punctuation at its ends. A memory must rest on the person's own words, not on
 * Ponder's reply or the writer's guess. Too short a quote proves nothing, so it fails.
 */
export function quotedIn(said: string, quote: string) {
	const plain = (text: string) =>
		text
			.normalize("NFC")
			.toLowerCase()
			.replace(/[‘’‛`]/g, "'")
			.replace(/[“”„]/g, '"')
			.replace(/\s+/g, " ")
			.trim();
	const needle = plain(quote).replace(/^[\s"'.,;:!?।-]+|[\s"'.,;:!?।-]+$/gu, "");
	return [...needle].length >= 3 && plain(said).includes(needle);
}

/** The saved memories and the quoted turn: the turn is data, not instructions. */
function describe({ turn, existing, forgotten = [] }: ExtractInput) {
	const saved = existing.length ? existing.map((m) => `- id ${m.id} [${m.kind}] ${JSON.stringify(m.text)}`).join("\n") : "(none yet)";
	return [
		`Memories saved so far:\n${saved}`,
		forgotten.length ? `Forgotten, at the person's request:\n${forgotten.map((text) => `- ${JSON.stringify(text)}`).join("\n")}` : "",
		`The person said:\n${JSON.stringify(turn.user)}`,
		`Ponder replied:\n${JSON.stringify(turn.assistant)}`,
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Turns the flat operations into typed ones, dropping any that miss what they need. */
function toOperations(flat: z.infer<typeof flatOperation>[]): Operation[] {
	return flat.flatMap((o): Operation[] => {
		const text = o.text.trim();
		const quote = o.quote.trim();
		if (o.op === "add") return text ? [{ op: "add", kind: o.kind, text, quote, reason: o.reason }] : [];
		if (!o.id) return [];
		if (o.op === "update") return text ? [{ op: "update", id: o.id, text, quote, reason: o.reason }] : [];
		return [{ op: "forget", id: o.id, reason: o.reason }];
	});
}
