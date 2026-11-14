import { computed, defineComponent, h, type PropType } from "vue";

/**
 * What frappe-ui's components import from vue-router, for the chat page, which has no
 * router: the chat's build points "vue-router" here (vite.config.ts), and /admin keeps
 * the real one. frappe-ui uses these only for a `route` prop, which the chat never passes,
 * and reads the router as absent when none is installed (Tabs, SidebarItem): the same as
 * here. vue-router was 24 KB of the chat's first page.
 */

/** No router is ever provided under this key. */
export const routerKey = Symbol("router");

/** As vue-router's, when no router is installed. */
export function useRouter() {
	return undefined;
}

/** A link to a path, for a `route` prop on a page with no router: an ordinary link. */
export function useLink(props: { to: unknown }) {
	const href = computed(() => (typeof props.to === "string" ? props.to : ""));
	return { href, route: computed(() => ({ href: href.value })), isActive: computed(() => false), isExactActive: computed(() => false), navigate: () => Promise.resolve() };
}

/** A plain <a> to `to`. */
export const RouterLink = defineComponent({
	name: "RouterLink",
	props: { to: { type: [String, Object] as PropType<unknown>, required: true } },
	setup(props, { slots }) {
		return () => h("a", { href: typeof props.to === "string" ? props.to : undefined }, slots.default?.());
	},
});
