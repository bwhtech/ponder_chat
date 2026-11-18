import { shallowRef } from "vue";
import { once } from "./once";

type Response = typeof import("./markdown-response").Response;

/**
 * Markdown drawn as replies are (frappe-ui-ai-elements' Response), for a page that shows some
 * but must not wait for it. The renderer is in the replies' chunk, which the page fetches once it
 * has loaded (Shell.vue), so it is mostly here already. `Markdown` is empty until it is; show
 * the text as it is until then.
 */
export const Markdown = shallowRef<Response>();

export const loadMarkdown = once(() =>
	import("./markdown-response").then((module) => {
		Markdown.value = module.Response;
		return module.Response;
	}),
);
