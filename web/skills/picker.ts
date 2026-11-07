import { computed, nextTick, ref, watch, type Ref } from "vue";
import { loadSkills, skills, type SkillOption } from "./skills";

/**
 * The $ menu of the message box. `$` at the start of a word opens it anywhere in the
 * message; `/` opens it only at the very start, as Builder's commands do, so commands can
 * join this menu later. The text after it filters the list. Choosing a skill takes the
 * typed `$name` out of the text and adds the skill to `chosen`, which shows as chips.
 *
 * The listeners go on an element around the textarea, in the capture phase, so the menu
 * gets Enter and the arrows before the textarea sends the message.
 */
export function useSkillPicker(text: Ref<string>, area: Ref<HTMLElement | null>) {
	const chosen = ref<string[]>([]);
	const caret = ref(0);
	const dismissed = ref(false);
	const active = ref(0);

	const typed = computed(() => {
		const before = text.value.slice(0, caret.value);
		const match = /(^|\s)([$/])([\w-]*)$/.exec(before);
		if (!match) return null;
		if (match[2] === "/" && before.trimStart() !== `/${match[3]}`) return null;
		return { query: match[3].toLowerCase(), start: caret.value - match[3].length - 1 };
	});

	const matches = computed<SkillOption[]>(() => {
		const query = typed.value?.query;
		if (query === undefined) return [];
		return skills.value
			.filter((skill) => !chosen.value.includes(skill.name))
			.filter((skill) => skill.name.includes(query) || skill.description.toLowerCase().includes(query))
			.sort((a, b) => Number(b.name.startsWith(query)) - Number(a.name.startsWith(query)));
	});

	const open = computed(() => Boolean(typed.value) && !dismissed.value && skills.value.length > 0);

	// A skill an admin turned on a moment ago shows the next time the menu opens.
	watch(
		() => Boolean(typed.value),
		(now) => now && void loadSkills(),
	);
	watch(text, () => {
		active.value = 0;
		dismissed.value = false;
		// The field was cleared (sent, or a draft swapped in): the caret is no longer where it was.
		if (!text.value) caret.value = 0;
	});

	function textarea() {
		return area.value?.querySelector("textarea") ?? null;
	}

	function syncCaret() {
		caret.value = textarea()?.selectionStart ?? text.value.length;
	}

	async function choose(skill: SkillOption) {
		const found = typed.value;
		if (!found) return;
		text.value = text.value.slice(0, found.start) + text.value.slice(caret.value);
		chosen.value = [...chosen.value, skill.name];
		await nextTick();
		const el = textarea();
		el?.focus();
		el?.setSelectionRange(found.start, found.start);
		caret.value = found.start;
	}

	function remove(name: string) {
		chosen.value = chosen.value.filter((each) => each !== name);
		textarea()?.focus();
	}

	/** Takes the chosen skills, for the message going out, and empties the chips. */
	function take() {
		const taken = chosen.value;
		chosen.value = [];
		return taken;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.isComposing) return;
		const list = matches.value;
		if (open.value && list.length && ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)) {
			// Shift+Enter still adds a line.
			if (event.key === "Enter" && event.shiftKey) return;
			event.preventDefault();
			event.stopPropagation();
			if (event.key === "ArrowDown") active.value = (active.value + 1) % list.length;
			else if (event.key === "ArrowUp") active.value = (active.value - 1 + list.length) % list.length;
			else void choose(list[active.value]!);
			return;
		}
		if (open.value && event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			dismissed.value = true;
			return;
		}
		// Backspace at the very start takes off the last chip.
		const el = textarea();
		if (event.key === "Backspace" && chosen.value.length && el?.selectionStart === 0 && el.selectionEnd === 0) {
			event.preventDefault();
			chosen.value = chosen.value.slice(0, -1);
		}
	}

	function onKeyup(event: KeyboardEvent) {
		if (!["ArrowDown", "ArrowUp"].includes(event.key) || !open.value) syncCaret();
	}

	return {
		chosen,
		typed,
		matches,
		open,
		active,
		choose,
		remove,
		take,
		/** Bind on the element around the textarea. */
		listeners: {
			onKeydownCapture: onKeydown,
			onKeyupCapture: onKeyup,
			onInputCapture: syncCaret,
			onClickCapture: syncCaret,
			onFocusinCapture: () => {
				dismissed.value = false;
				syncCaret();
			},
			onFocusoutCapture: () => (dismissed.value = true),
		},
	};
}
