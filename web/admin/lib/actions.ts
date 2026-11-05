import { dialog, toast } from "frappe-ui";
import { api, type Person } from "../api";
import { refreshCounts } from "../store";

/**
 * The menu of actions for one person, shared by the people list and the person page.
 * `changed` runs after an action, so the page loads the person again. `removed` runs
 * after an invite is cancelled, so a page about that person can leave. `giveExtra` adds
 * "Give extra credits today" (the person page has it).
 */
type Handlers = {
	openCredits: (person: Person) => void;
	changed: () => void;
	removed?: () => void;
	giveExtra?: (person: Person) => void;
	/** Signed-in sessions, when the page knows them, for the sign-out message. */
	sessions?: number;
};

export function personActions(person: Person, handlers: Handlers) {
	const setCredits = { label: "Set daily credits", icon: "lucide-gauge", onClick: () => handlers.openCredits(person) };
	if (person.status === "invited") {
		return [
			setCredits,
			{ label: "Email the invite again", icon: "lucide-send", onClick: () => void emailInvite(person) },
			{ label: "Cancel invite", icon: "lucide-x", theme: "red" as const, onClick: () => cancelInvite(person, handlers) },
		];
	}
	const roleAction =
		person.role === "admin"
			? { label: "Remove admin role", icon: "lucide-shield-off", onClick: () => setRole(person, "user", handlers) }
			: { label: "Make admin", icon: "lucide-shield", onClick: () => setRole(person, "admin", handlers) };
	const banAction =
		person.status === "banned"
			? { label: "Unban", icon: "lucide-undo-2", onClick: () => void unban(person, handlers) }
			: { label: "Ban", icon: "lucide-ban", theme: "red" as const, onClick: () => ban(person, handlers) };
	const giveExtra = handlers.giveExtra;
	return [
		setCredits,
		...(giveExtra ? [{ label: "Give extra credits today", icon: "lucide-plus", onClick: () => giveExtra(person) }] : []),
		roleAction,
		{ label: "Sign out everywhere", icon: "lucide-log-out", onClick: () => signOutEverywhere(person, handlers) },
		banAction,
	];
}

/** Calls the admin API for one person. */
function act(person: Person, action: string, body: unknown = {}, method = "POST") {
	return api(`/people/${encodeURIComponent(person.id)}/${action}`, { method, body });
}

async function emailInvite(person: Person) {
	try {
		await api(`/invites/${encodeURIComponent(person.email)}/send`, { body: {} });
		toast.success(`Sent to ${person.email}`);
	} catch (e) {
		toast.error((e as Error).message);
	}
}

function cancelInvite(person: Person, handlers: Handlers) {
	dialog.danger({
		title: `Cancel the invite for ${person.email}?`,
		message: "They won't be able to sign in. You can invite them again later.",
		confirmLabel: "Cancel invite",
		cancelLabel: "Keep",
		onConfirm: async () => {
			await api(`/invites/${encodeURIComponent(person.email)}`, { method: "DELETE" });
			toast.success("Invite cancelled");
			void refreshCounts();
			if (handlers.removed) handlers.removed();
			else handlers.changed();
		},
	});
}

function setRole(person: Person, role: "admin" | "user", handlers: Handlers) {
	dialog.confirm({
		title: role === "admin" ? `Make ${person.name} an admin?` : `Remove ${person.name}'s admin role?`,
		message:
			role === "admin"
				? "Admins can open this page, invite and ban people, and change credits."
				: "They keep using the chat, but can no longer open this page.",
		confirmLabel: role === "admin" ? "Make admin" : "Remove admin role",
		onConfirm: async () => {
			await act(person, "role", { role }, "PUT");
			toast.success(role === "admin" ? `${person.name} is now an admin` : `${person.name} is no longer an admin`);
			handlers.changed();
		},
	});
}

function signOutEverywhere(person: Person, handlers: Handlers) {
	const sessions = handlers.sessions;
	const what = sessions === undefined ? "all their sessions" : `their ${sessions} session${sessions === 1 ? "" : "s"}`;
	dialog.confirm({
		title: `Sign ${person.name} out everywhere?`,
		message: `This ends ${what}. They can sign in again with a new link or code.`,
		confirmLabel: "Sign out",
		onConfirm: async () => {
			await act(person, "sign-out");
			toast.success(`${person.name} is signed out`);
			handlers.changed();
		},
	});
}

function ban(person: Person, handlers: Handlers) {
	dialog.prompt({
		title: `Ban ${person.name}?`,
		message: "They are signed out everywhere and cannot sign in until you unban them. Their chats are kept.",
		theme: "red",
		confirmLabel: "Ban",
		fields: [
			{ name: "reason", label: "Reason", description: "Only admins see this.", type: "text" },
			{
				name: "until",
				label: "For how long",
				type: "select",
				defaultValue: "forever",
				options: [
					{ label: "Until I unban them", value: "forever" },
					{ label: "1 day", value: "1" },
					{ label: "7 days", value: "7" },
					{ label: "30 days", value: "30" },
				],
			},
		],
		onConfirm: async ({ values }) => {
			const days = values.until === "forever" ? null : Number(values.until);
			await act(person, "ban", { reason: String(values.reason ?? ""), days });
			toast.success(`${person.name} is banned`);
			handlers.changed();
		},
	});
}

async function unban(person: Person, handlers: Handlers) {
	try {
		await act(person, "unban");
		toast.success(`${person.name} can sign in again`);
		handlers.changed();
	} catch (e) {
		toast.error((e as Error).message);
	}
}
