import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A stand-in for OpenRouter in the document tests: the outside system, so the real
 * embedder and the real page reader run against it. Set OPENROUTER_BASE_URL to `url`
 * before the app's layer is built.
 *
 * - Embeddings: a vector of three topics (doses, exit-site care, bleeding), so a question
 *   is near the passages about it. Each call costs EMBED_COST.
 * - Chat completions (the page reader): the text in `pages` for the page in the file's
 *   name, "fail" for a refusal that is not retried, and no text for any other page.
 */
export const EMBED_COST = 0.00002;
export const PAGE_COST = 0.002;

const TOPICS = [/dose|vancomycin|cefazolin|mg\/kg/i, /exit site|catheter/i, /bleed|misoprostol/i];
export const meaning = (text: string) => TOPICS.map((topic) => (topic.test(text) ? 1 : 0.01));

export type FakeOpenRouter = {
	url: string;
	/** Page number to the model's text, or "fail". */
	pages: Map<number, string>;
	/** The texts of each embedding call, in order. */
	embedded: string[][];
	close: () => Promise<void>;
};

export async function startFakeOpenRouter(): Promise<FakeOpenRouter> {
	const pages = new Map<number, string>();
	const embedded: string[][] = [];
	const server = createServer(async (request, response) => {
		const body = request.method === "POST" ? JSON.parse(await read(request)) : {};
		const send = (status: number, json: unknown) => {
			response.writeHead(status, { "Content-Type": "application/json" });
			response.end(JSON.stringify(json));
		};
		if (request.url?.endsWith("/v1/embeddings")) {
			const input = body.input as string[];
			embedded.push(input);
			const data = input.map((text, index) => ({ object: "embedding", index, embedding: meaning(text) }));
			return send(200, { object: "list", model: body.model, data, usage: { prompt_tokens: input.length * 7, total_tokens: input.length * 7, cost: EMBED_COST } });
		}
		if (request.url?.endsWith("/v1/chat/completions")) {
			const file = JSON.stringify(body.messages).match(/page-(\d+)\.pdf/);
			const answer = pages.get(Number(file?.[1]));
			if (answer === "fail") return send(400, { error: { message: "Provider returned error" } });
			const usage = { cost: PAGE_COST, prompt_tokens: 1_200, completion_tokens: 80 };
			return send(200, { id: `gen-${file?.[1]}`, model: body.model, choices: [{ finish_reason: "stop", message: { content: answer ?? "" } }], usage });
		}
		send(404, { error: { message: "Not here" } });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
	return { url, pages, embedded, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

async function read(request: IncomingMessage) {
	let text = "";
	for await (const chunk of request) text += chunk;
	return text;
}
