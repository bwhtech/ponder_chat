import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { ToggleButton, ToggleButtonGroup } from "@astryxdesign/core/ToggleButton";
import { AcademicCapIcon, ChartBarIcon, MapIcon, PencilSquareIcon, SparklesIcon } from "@heroicons/react/24/outline";
import { useState, type ReactNode } from "react";
import { displayName, me } from "../lib/account";
import { features } from "../lib/models";
import { useStore } from "../lib/store";

/**
 * A new chat, before anything is written: a greeting, the message field in the middle of the
 * page, and ideas to start from, after Astryx's ai-chat-landing template. A category shows
 * its ideas as cards; a card puts its prompt in the field to finish and send.
 */
type Idea = { heading: string; body: string; prompt: string };

const IDEAS: Record<string, Idea[]> = {
	learn: [
		{ heading: "Explain a concept", body: "Like I'm new to it, with an example", prompt: "Explain this like I'm new to it: " },
		{ heading: "Quiz me", body: "Five questions to check what I know", prompt: "Quiz me with five questions on " },
		{ heading: "Compare two ideas", body: "Where they agree and where they differ", prompt: "Compare and contrast " },
		{ heading: "Summarise a topic", body: "The key points in a short page", prompt: "Summarise the key points of " },
	],
	write: [
		{ heading: "A polite follow-up", body: "An email that nudges without pushing", prompt: "Help me write a polite follow-up email about " },
		{ heading: "Improve my writing", body: "Clearer, shorter, same voice", prompt: "Make this clearer and shorter, in the same voice:\n\n" },
		{ heading: "Draft a document", body: "Written as an artifact you can download", prompt: "Write a short document as an artifact about " },
		{ heading: "Make a slide deck", body: "A few slides you can present", prompt: "Make a 5-slide deck about " },
	],
	plan: [
		{ heading: "A trip on a budget", body: "Day by day, with rough costs", prompt: "Plan a 3-day trip on a small budget to " },
		{ heading: "A week of meals", body: "Simple dinners and a shopping list", prompt: "Plan a week of simple dinners for " },
		{ heading: "A project", body: "Steps, owners and a timeline", prompt: "Help me plan this project: " },
		{ heading: "A hard conversation", body: "What to say, and how", prompt: "Help me prepare for a conversation about " },
	],
	analyse: [
		{ heading: "Chart some numbers", body: "Python draws it for you", prompt: "Chart compound interest on 10,000 at 7% over 20 years" },
		{ heading: "Look into a file", body: "Attach a CSV or a PDF first", prompt: "Look at the attached file and tell me what stands out." },
		{ heading: "Search the web", body: "With sources you can check", prompt: "Search the web for the latest on " },
		{ heading: "Weigh a decision", body: "Pros, cons and what would change my mind", prompt: "Help me weigh this decision: " },
	],
};

const CATEGORIES = [
	{ key: "learn", label: "Learn", icon: AcademicCapIcon },
	{ key: "write", label: "Write", icon: PencilSquareIcon },
	{ key: "plan", label: "Plan", icon: MapIcon },
	{ key: "analyse", label: "Analyse", icon: ChartBarIcon },
] as const;

export default function Landing({ composer, onIdea }: { composer: ReactNode; onIdea: (prompt: string) => void }) {
	const person = useStore(me);
	const python = useStore(features).python;
	const [category, setCategory] = useState<string | null>(null);
	const name = displayName(person);
	// Charts need Python; without it the first idea is left out.
	const ideas = category ? IDEAS[category]!.filter((idea) => python || idea.heading !== "Chart some numbers") : [];

	return (
		<div className="flex min-h-0 flex-1 overflow-y-auto" data-slot="landing">
			<div className="m-auto flex w-full max-w-[720px] flex-col gap-8 px-4 py-10 sm:px-6">
				<VStack gap={1}>
					<HStack gap={2} vAlign="center">
						<Icon icon={SparklesIcon} size="md" color="accent" />
						<Text type="large" as="h2">
							{name ? `Hi, ${name}` : "Hi there"}
						</Text>
					</HStack>
					<Text type="display-2" as="h1">
						Where should we start?
					</Text>
				</VStack>

				{composer}

				<VStack gap={5}>
					<div className="overflow-x-auto">
						<ToggleButtonGroup label="Ideas" value={category} onChange={(value) => setCategory(value as string | null)} size="lg">
							{CATEGORIES.map((each) => (
								<ToggleButton key={each.key} value={each.key} label={each.label} icon={<Icon icon={each.icon} size="sm" />} />
							))}
						</ToggleButtonGroup>
					</div>
					{ideas.length > 0 && (
						<Grid columns={{ minWidth: 260, max: 2 }} gap={3}>
							{ideas.map((idea) => (
								<ClickableCard key={idea.heading} label={idea.heading} variant="muted" padding={3} onClick={() => onIdea(idea.prompt)}>
									<VStack gap={0.5}>
										<Heading level={4}>{idea.heading}</Heading>
										<Text type="body" color="secondary" size="xsm">
											{idea.body}
										</Text>
									</VStack>
								</ClickableCard>
							))}
						</Grid>
					)}
				</VStack>
			</div>
		</div>
	);
}
