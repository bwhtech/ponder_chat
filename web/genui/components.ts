import { resolveStateField } from "@openuidev/lang-core";
import { useIsStreaming, useOpenUI, useTriggerAction, type ActionConfig, type ComponentRenderProps } from "@openuidev/vue-lang";
import { Alert, Badge, Button, TabButtons } from "frappe-ui";
import { BarChart, DonutChart, LineChart, NumberCard } from "frappe-ui/charts";
import { List, ListCell, ListHeader, ListHeaderCell, ListRow } from "frappe-ui/list";
import { computed, defineComponent, h, onUnmounted, ref, type VNode } from "vue";
import { fullDate } from "../dates";
import { amount, count } from "../numbers";
import { genuiLibrary, type GenuiRenderers } from "../../shared/genui";

/**
 * Each OpenUI component (shared/genui.ts) drawn with frappe-ui. The Renderer hands each one
 * `props` (the model's arguments, by name) and `renderNode` (draws a child). These follow
 * frappe-ui's own OpenUI library (frappe/frappe-ui#1329); Table and Col are Ponder's.
 *
 * Charts, lists and tables sit in the bordered box that /admin's dashboard uses, with its
 * label lift and its firmer dark edges (data-slot="dashboard", base.css). A chart fills the box it is in, and a box
 * with no height shows nothing. While the model writes, a part may arrive without its data:
 * every renderer draws something sensible from missing arguments.
 */
type Render<P> = ComponentRenderProps<Partial<P>>;
type Row = Record<string, unknown>;
type ColNode = { props?: { label?: string; key?: string; format?: Format } };
type Format = "text" | "number" | "currency" | "percent" | "date" | "badge";

const BOX = "rounded-4 border border-outline-gray-1 bg-surface-elevation-2";
// Charts move as /admin's do, and not at all with reduced motion.
const chartMotion = () => (matchMedia("(prefers-reduced-motion: reduce)").matches ? { animation: false } : { animationDuration: 250, animationDurationUpdate: 200 });

const Stack = ({ props, renderNode }: Render<{ children: unknown[] }>) => h("div", { class: "flex min-w-0 flex-col gap-4" }, [renderNode(props.children)]);

// Equal columns that wrap below 10rem each, so two to four cards share a row on a phone too.
const Row = ({ props, renderNode }: Render<{ children: unknown[] }>) =>
	h("div", { class: "grid min-w-0 grid-cols-[repeat(auto-fit,minmax(10rem,1fr))] gap-4", "data-slot": "dashboard" }, [renderNode(props.children)]);

const Heading = ({ props }: Render<{ text: string }>) => h("h3", { class: "text-lg-semibold text-ink-gray-9" }, props.text ?? "");

const Text = ({ props }: Render<{ text: string }>) => h("p", { class: "text-p-base text-ink-gray-7" }, props.text ?? "");

const BadgeNode = ({ props }: Render<{ label: string | number; theme: string; variant: string }>) =>
	h(Badge, { label: props.label == null ? "" : String(props.label), theme: (props.theme ?? "gray") as never, variant: (props.variant ?? "subtle") as never });

const AlertNode = ({ props }: Render<{ title: string; description: string; theme: string }>) =>
	h(Alert, { title: props.title ?? "", description: props.description, theme: (props.theme ?? "gray") as never });

/** A button runs its Action: @ToAssistant sends a message, @OpenUrl opens a page, @Set changes a $variable. Without one, it sends its label. */
const ButtonNode = defineComponent({
	props: ["props", "renderNode"],
	setup(attrs: Render<{ label: string; action: unknown; variant: string; theme: string }>) {
		const triggerAction = useTriggerAction();
		const streaming = useIsStreaming();
		return () =>
			h(Button, {
				label: attrs.props.label ?? "",
				variant: (attrs.props.variant ?? "subtle") as never,
				theme: (attrs.props.theme ?? "gray") as never,
				disabled: streaming.value,
				// 44px to a finger, without moving the layout (Buttons spaces them so the areas do not overlap).
				class: "touch-target",
				onClick: () => triggerAction(attrs.props.label ?? "", undefined, attrs.props.action as ActionConfig | undefined),
			});
	},
});

const Buttons = ({ props, renderNode }: Render<{ buttons: unknown[] }>) =>
	h("div", { class: "flex flex-wrap gap-2 [@media(pointer:coarse)]:gap-4" }, [renderNode(props.buttons)]);

/**
 * Tabs bound to a $variable: a click sets it, and the parts of the card that read it change.
 * Unbound, or bound to a $variable never declared, they keep their own choice, from the first option.
 */
const TabButtonsNode = defineComponent({
	props: ["props", "renderNode"],
	setup(attrs: Render<{ options: string[]; value: unknown }>) {
		const openui = useOpenUI();
		// The store is not a Vue ref: count its changes so the computed below reads it again.
		const version = ref(0);
		onUnmounted(openui.store.subscribe(() => version.value++));
		const own = ref<string>();
		const options = computed(() => (Array.isArray(attrs.props.options) ? attrs.props.options.filter((option) => option != null).map(String) : []));
		const field = computed(() => {
			void version.value;
			return resolveStateField<string>("tabs", attrs.props.value, openui.store, openui.evaluationContext, () => own.value, (_, next) => (own.value = String(next)));
		});
		const current = computed(() => {
			const value = field.value.value;
			return typeof value === "string" && options.value.includes(value) ? value : options.value[0];
		});
		return () =>
			options.value.length
				? h(TabButtons, {
						class: "self-start",
						options: options.value.map((option) => ({ label: option, value: option })),
						modelValue: current.value,
						"onUpdate:modelValue": (next: unknown) => field.value.setValue(String(next)),
					})
				: null;
	},
});

const NumberCardNode = ({ props }: Render<{ title: string; value: number | string; prefix: string; suffix: string; delta: number }>) =>
	h(NumberCard, {
		title: props.title ?? "",
		value: props.value ?? null,
		format: count,
		prefix: props.prefix ?? undefined,
		suffix: props.suffix ?? undefined,
		delta: typeof props.delta === "number" ? props.delta : undefined,
	});

function chartBox(chart: VNode) {
	return h("div", { class: `${BOX} h-72 min-w-0 p-3 md:p-4`, "data-slot": "dashboard" }, [chart]);
}

const axisProps = (props: Partial<{ data: Row[]; x: string; y: string | string[]; title: string }>) => ({
	data: Array.isArray(props.data) ? props.data : [],
	x: props.x ?? "",
	y: props.y ?? [],
	title: props.title ?? undefined,
	echartOptions: chartMotion(),
});

const BarChartNode = ({ props }: Render<{ data: Row[]; x: string; y: string | string[]; title: string; stacked: boolean; horizontal: boolean }>) =>
	chartBox(h(BarChart, { ...axisProps(props), stacked: props.stacked ?? undefined, horizontal: props.horizontal ?? undefined, palette: "categorical" } as never));

const LineChartNode = ({ props }: Render<{ data: Row[]; x: string; y: string | string[]; title: string }>) => chartBox(h(LineChart, axisProps(props) as never));

const DonutChartNode = ({ props }: Render<{ data: Row[]; category: string; value: string; title: string }>) =>
	chartBox(
		h(DonutChart, {
			data: Array.isArray(props.data) ? props.data : [],
			category: props.category ?? "",
			value: props.value ?? "",
			title: props.title ?? undefined,
			format: count,
			echartOptions: chartMotion(),
		} as never),
	);

const ListRowNode = ({ props, renderNode }: Render<{ title: string; description: string; aside: unknown }>) =>
	h(ListRow, null, () => [
		h(ListCell, null, () =>
			h("div", { class: "min-w-0 py-2" }, [
				h("div", { class: "truncate text-base text-ink-gray-8" }, props.title ?? ""),
				props.description ? h("div", { class: "mt-1 truncate text-sm text-ink-gray-6" }, props.description) : null,
			]),
		),
		h(ListCell, { class: "justify-end text-sm text-ink-gray-6" }, () => renderNode(props.aside)),
	]);

const ListNode = ({ props, renderNode }: Render<{ rows: unknown[] }>) =>
	h("div", { class: `${BOX} min-w-0 px-3 py-1`, "data-slot": "dashboard" }, [h(List, { columns: ["minmax(0,1fr)", "auto"] }, () => renderNode(props.rows))]);

const NUMERIC: Format[] = ["number", "currency", "percent"];

/** A table: frappe-ui's List with a header, one row per item. Wide tables scroll sideways in their box. */
const TableNode = ({ props }: Render<{ data: Row[]; columns: ColNode[]; title: string; currency: string }>) => {
	const columns = (props.columns ?? []).map((col) => ({ label: col?.props?.label ?? "", key: col?.props?.key ?? "", format: col?.props?.format ?? "text" }));
	const rows = Array.isArray(props.data) ? props.data : [];
	// The first column names the item; the others share the rest, so their headers have room.
	const tracks = columns.map((_, index) => (index === 0 ? "minmax(8rem,1.25fr)" : "minmax(6rem,1fr)"));
	const cell = (row: Row, col: (typeof columns)[number]) => {
		const value = row?.[col.key];
		if (col.format === "badge") return value == null || value === "" ? "" : h(Badge, { label: String(value), theme: "gray", variant: "subtle" });
		return formatCell(value, col.format, props.currency ?? "USD");
	};
	return h("div", { class: "flex min-w-0 flex-col gap-2" }, [
		props.title ? h("h4", { class: "text-base-medium text-ink-gray-8" }, props.title) : null,
		h("div", { class: `${BOX} scroll-fade-x min-w-0 overflow-x-auto px-3 py-1 [--scroll-fade-size:24px]`, "data-slot": "dashboard" }, [
			h("div", { style: { minWidth: `${2 + columns.length * 6}rem` } }, [
				h(List, { columns: tracks.length ? tracks : ["minmax(0,1fr)"] }, () => [
					h(ListHeader, null, () => columns.map((col) => h(ListHeaderCell, { class: NUMERIC.includes(col.format) ? "justify-end" : undefined }, () => col.label))),
					...rows.map((row) =>
						h(ListRow, null, () =>
							columns.map((col) =>
								h(ListCell, { class: ["py-2 text-base text-ink-gray-8", NUMERIC.includes(col.format) && "justify-end tabular-nums"] }, () => cell(row, col)),
							),
						),
					),
				]),
			]),
		]),
	]);
};

function formatCell(value: unknown, format: Format, currency: string) {
	if (value == null || value === "") return "—";
	const number = typeof value === "number" ? value : Number(value);
	if (format === "number" && Number.isFinite(number)) return count(number);
	if (format === "currency" && Number.isFinite(number)) return amount(number, currency);
	if (format === "percent" && Number.isFinite(number)) return `${count(number)}%`;
	if (format === "date" && !Number.isNaN(Date.parse(String(value)))) return fullDate(String(value));
	return String(value);
}

const nothing = () => null;

const RENDERERS: GenuiRenderers = {
	Stack,
	Row,
	Heading,
	Text,
	Badge: BadgeNode,
	Alert: AlertNode,
	Button: ButtonNode,
	Buttons,
	TabButtons: TabButtonsNode,
	NumberCard: NumberCardNode,
	BarChart: BarChartNode,
	LineChart: LineChartNode,
	DonutChart: DonutChartNode,
	List: ListNode,
	ListRow: ListRowNode,
	Table: TableNode,
	// A Col is data its Table reads; it draws nothing itself.
	Col: nothing,
};

// The same library the server checks programs against, with the Vue renderers in it.
export const genuiVueLibrary = genuiLibrary(RENDERERS) as unknown as import("@openuidev/vue-lang").Library;
