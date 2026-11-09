import type { UIMessage } from "ai";
import { toast } from "frappe-ui";
import { modelName } from "./models";
import { CITATION_PART, type CitationPart } from "./cite/citations";

/**
 * A chat as a Markdown file, made in the browser from the saved thread: what the person
 * and Ponder wrote, with the model of each reply. Attached files and files that Python
 * made are listed by name; searches, pages read and Python code are summed up in a line
 * or a code block. Nothing is sent anywhere.
 */
export async function downloadThreadMarkdown(id: string, title: string) {
	try {
		const response = await fetch(`/api/threads/${encodeURIComponent(id)}`, { cache: "no-store" });
		if (!response.ok) throw new Error(String(response.status));
		const { messages } = (await response.json()) as { messages: UIMessage[] };
		download(`${fileName(title)}.md`, threadMarkdown(title, messages));
	} catch {
		toast.error("The chat could not be exported. Try again.");
	}
}

export function threadMarkdown(title: string, messages: UIMessage[]) {
	const sections = messages.map((message) => {
		const heading = message.role === "user" ? "## You" : `## Ponder${replyModel(message)}`;
		return [heading, ...message.parts.map(partMarkdown).filter(Boolean)].join("\n\n");
	});
	return `# ${title}\n\n${sections.join("\n\n---\n\n")}\n`;
}

/** A quote from an earlier reply, as a blockquote, with the person's comment under it. */
function citationMarkdown(citation: CitationPart["data"]): string {
	const quote = citation.text.trim().split("\n").map((line) => `> ${line}`).join("\n");
	return citation.comment ? `${quote}\n\n${citation.comment}` : quote;
}

type Part = UIMessage["parts"][number];
type ToolPart = { type: string; state?: string; input?: Record<string, unknown>; output?: Record<string, unknown> };

function partMarkdown(part: Part): string {
	if (part.type === "text") return part.text.trim();
	if (part.type === "file") return `📎 ${part.filename ?? "Attached file"}`;
	if (part.type === CITATION_PART) return citationMarkdown((part as CitationPart).data);
	if (!part.type.startsWith("tool-")) return "";
	const tool = part as unknown as ToolPart;
	const name = part.type.slice("tool-".length);
	if (name === "web_search") return `> Searched the web for “${String(tool.input?.query ?? "")}”`;
	if (name === "web_fetch") return `> Read ${String(tool.output?.url ?? tool.input?.url ?? "a page")}`;
	if (name === "run_python") return pythonMarkdown(tool);
	return "";
}

function pythonMarkdown(tool: ToolPart) {
	const code = String(tool.input?.code ?? "").trim();
	const files = (tool.output?.files as { name: string }[] | undefined) ?? [];
	return [
		"> Ran Python",
		code && "```python\n" + code + "\n```",
		files.length ? files.map((file) => `📎 ${file.name}`).join("\n") : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

function replyModel(message: UIMessage) {
	const id = (message.metadata as { model?: string } | undefined)?.model;
	return id ? ` (${modelName(id) ?? id})` : "";
}

function fileName(title: string) {
	return title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Chat";
}

function download(name: string, text: string) {
	const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
	const link = Object.assign(document.createElement("a"), { href: url, download: name });
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
