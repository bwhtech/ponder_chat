/**
 * frappe-ui's Breadcrumbs, in a chunk of its own. With the menu it opens for a long trail, it
 * would double the chat's first code. A chat in a workspace loads it (Shell.vue), and draws
 * BreadcrumbsStandIn.vue until it is here; the page also fetches it once it has loaded
 * (server/web-build.ts).
 */
export { Breadcrumbs } from "frappe-ui";
