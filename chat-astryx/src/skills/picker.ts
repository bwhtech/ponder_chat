import type { KeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { skillTrigger } from "./SkillMenu";
import { loadSkills, skills } from "./skills";

/**
 * The skills the person chose for the message they are writing, with $name in the message
 * box (SkillMenu.tsx). Each is a chip until the message goes out. The menu opens only when
 * some skill is on, so a `$` in plain text opens nothing.
 */
export function useSkillPicker() {
	const hasSkills = useStore(skills).length > 0;
	const [chosen, setChosen] = useState<string[]>([]);
	const latest = useRef(chosen);
	latest.current = chosen;

	useEffect(() => {
		void loadSkills();
	}, []);

	const triggers = useMemo(
		() => (hasSkills ? [skillTrigger(() => latest.current, (name) => setChosen((list) => (list.includes(name) ? list : [...list, name])))] : []),
		[hasSkills],
	);

	function remove(name: string) {
		setChosen((list) => list.filter((each) => each !== name));
	}

	/** Takes the chosen skills, for the message going out, and empties the chips. */
	function take() {
		const taken = latest.current;
		setChosen([]);
		return taken;
	}

	/** Backspace at the very start of the field takes off the last chip. */
	function onKeyDown(event: KeyboardEvent<HTMLElement>) {
		if (event.key !== "Backspace" || !latest.current.length || !caretAtStart(event.currentTarget)) return;
		event.preventDefault();
		setChosen((list) => list.slice(0, -1));
	}

	return {
		chosen,
		/** Gives skills back to the chips when a message did not go out. */
		restore: setChosen,
		placeholder: hasSkills ? "Message Ponder Chat. Type $ for skills" : "Message Ponder Chat",
		triggers,
		remove,
		take,
		onKeyDown,
	};
}

function caretAtStart(field: HTMLElement) {
	const selection = document.getSelection();
	if (!selection?.isCollapsed || !selection.rangeCount) return false;
	const before = document.createRange();
	before.selectNodeContents(field);
	const caret = selection.getRangeAt(0);
	before.setEnd(caret.startContainer, caret.startOffset);
	return before.toString() === "";
}
