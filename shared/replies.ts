/**
 * The data chunk that tells the page to load its thread again, as it is saved: the
 * approval it answered was used already, in another tab or an earlier reply
 * (server/workflow/answered-again.ts, web/ChatView.vue). Transient: it is never saved.
 */
export const THREAD_CHANGED = "data-thread-changed";
