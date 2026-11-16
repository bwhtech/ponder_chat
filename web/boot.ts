import type { client, Answer } from "./api";
import type { LogoVersions } from "./brand";

/**
 * What the server put in the page for its first screen (server/boot-page.ts): who is
 * signed in (null when nobody is), their chats, the models, the skills, the features and the logos.
 * The same answers as the API's, so the page draws without asking it first. Each is used
 * once, by the first load; later loads ask the API. In development (npm run dev) the page
 * has none, and every load asks.
 */
type Boot = {
	me?: Answer<typeof client.api.me.$get> | null;
	/** The logos an admin set (brand.ts). */
	logos?: LogoVersions;
	threads?: Answer<typeof client.api.threads.$get>["threads"];
	models?: Answer<typeof client.api.models.$get>;
	features?: Answer<typeof client.api.features.$get>;
	skills?: Answer<typeof client.api.skills.$get>["skills"];
	/** The files of the chat's later code and of what a first tap waits for, and for an admin /admin's, to prefetch (preload.ts). */
	prefetch?: string[];
};

const boot: Boot = read();

/** The part the server sent, or undefined when it sent none or it was used already. */
export function fromBoot<K extends keyof Boot>(key: K): Boot[K] | undefined {
	const value = boot[key];
	delete boot[key];
	return value;
}

function read(): Boot {
	try {
		return JSON.parse(document.getElementById("ponder-boot")?.textContent || "{}") as Boot;
	} catch {
		return {};
	}
}
