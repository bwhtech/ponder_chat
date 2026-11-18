import { computed, reactive, ref, shallowRef } from "vue";
import { ApiError } from "../api";
import { displayName } from "../../shared/display-name";
import type { Member, MemberAccess, OrgAccess, Person, WorkspaceDetail } from "./store";

/**
 * What Share shows and saves (ShareDialog.vue). Each change applies at once: the dialog shows
 * it straight away, and it is saved in the background, one request at a time, in the order the
 * changes were made. So the answers come in order, each newer than the one before, and two
 * changes to one person never pass each other. A change the person makes to someone whose last
 * change is still on its way waits, and only their latest choice is sent.
 *
 * There is one queue for each workspace, not one for each dialog: Share closed and opened again
 * while a change is on its way finds that change, and its own changes go after it. The dialog
 * that opened last gets the answers; one that closed gets nothing more.
 *
 * Each choice has a number. When an answer comes, the choices it answers (that number and
 * older) give way to what the server says, even when the server says something else (someone
 * changed it meanwhile); only choices made after the request went stay on screen. A change the
 * server refuses is taken back, with a line that says why, unless the person changed that row
 * again meanwhile. A workspace gone for the person (404) ends Share, whatever else is queued. A
 * 403 asks the server again whether the person can still share: when they can't, Share ends.
 */
export type SharingApi = {
	setMember: (userId: string, access: MemberAccess) => Promise<WorkspaceDetail>;
	removeMember: (userId: string) => Promise<WorkspaceDetail>;
	setOrgAccess: (orgAccess: OrgAccess) => Promise<WorkspaceDetail>;
	/** The workspace as the person sees it now: after a 403, to learn whether they can still share. */
	refresh: () => Promise<WorkspaceDetail>;
};

export type SharingEvents = {
	/** Each answer, in order: the workspace as the person sees it now. */
	saved: (workspace: WorkspaceDetail) => void;
	/**
	 * The person can no longer share it, and nothing more is sent: they removed themselves or
	 * gave themselves Can ask (`self`), or someone else changed their role (`changed`).
	 */
	lost: (workspace: WorkspaceDetail, why: "self" | "changed") => void;
	/** The workspace is gone for this person: deleted, or they were removed. Nothing more is sent. */
	gone: () => void;
	/** A change was refused and taken back: what to say. */
	failed: (message: string) => void;
};

/** The row of General access in the queue: member rows are keyed by the person's id. */
const GENERAL = "\u0000general";

type Choice<T> = { value: T; number: number };
type Session = ReturnType<typeof createSession>;

/** The queue of each workspace, while it has work to do. */
const sessions = new Map<string, Session>();

/**
 * Share's state for this workspace. A queue that still has work is taken over: its answers go
 * to these callbacks from now on, and the dialog shows its choices still on their way.
 */
export function useSharing(initial: WorkspaceDetail, api: SharingApi, events: SharingEvents, me: string) {
	const existing = sessions.get(initial.id);
	if (existing?.busy()) {
		existing.attach(api, events);
		return existing.view;
	}
	const session = createSession(initial, api, events, me);
	sessions.set(initial.id, session);
	return session.view;
}

function createSession(initial: WorkspaceDetail, firstApi: SharingApi, firstEvents: SharingEvents, me: string) {
	let api = firstApi;
	let events = firstEvents;
	/** The last answer. */
	const saved = shallowRef(initial);
	/** The person's choice for each row while it is not yet answered: null removes the person. */
	const wanted = reactive(new Map<string, Choice<MemberAccess | null>>());
	const wantedOrg = ref<Choice<OrgAccess> | null>(null);
	/** People added here, by id, until an answer has them. */
	const added = new Map<string, Person>();
	/** The rows' order: as Share first opened, then each person in the order they were added. Nothing moves meanwhile. */
	const order = ref<string[]>((initial.members ?? []).map((member: Member) => member.id));
	const queue: string[] = [];
	let numbers = 0;
	let running = false;
	let stopped = false;

	const members = computed<Member[]>(() => {
		const byId = new Map<string, Member>((saved.value.members ?? []).map((member: Member) => [member.id, member]));
		const ids = [...order.value, ...[...byId.keys()].filter((id) => !order.value.includes(id))];
		return ids.flatMap((id) => {
			const person = byId.get(id) ?? added.get(id);
			const access = wanted.has(id) ? wanted.get(id)?.value : byId.get(id)?.access;
			return person && access ? [{ id, name: person.name, email: person.email, access }] : [];
		});
	});
	const orgAccess = computed<OrgAccess>(() => wantedOrg.value?.value ?? saved.value.orgAccess);

	function add(person: Person, access: MemberAccess) {
		added.set(person.id, person);
		if (!order.value.includes(person.id)) order.value = [...order.value, person.id];
		choose(person.id, access);
	}

	function choose(userId: string, access: MemberAccess | null) {
		wanted.set(userId, { value: access, number: ++numbers });
		enqueue(userId);
	}

	function setGeneral(value: OrgAccess) {
		wantedOrg.value = { value, number: ++numbers };
		enqueue(GENERAL);
	}

	function enqueue(key: string) {
		if (stopped) return;
		if (!queue.includes(key)) queue.push(key);
		void drain();
	}

	async function drain() {
		if (running) return;
		running = true;
		while (queue.length && !stopped) await write(queue.shift()!);
		running = false;
		if (!busy() && sessions.get(saved.value.id) === session) sessions.delete(saved.value.id);
	}

	function savedAccess(userId: string) {
		return saved.value.members?.find((member: Member) => member.id === userId)?.access ?? null;
	}

	async function write(key: string) {
		const choice = key === GENERAL ? wantedOrg.value : wanted.get(key);
		if (!choice) return;
		const current = key === GENERAL ? saved.value.orgAccess : savedAccess(key);
		// Nothing to send: the server has it already.
		if (choice.value === current) return void forget(key, choice.number);
		const before = savedAccess(key);
		try {
			const answer = await send(key, choice.value);
			if (stopped) return;
			saved.value = answer;
			// The choices this answers give way to the server's state; a newer one stays, and is queued.
			forget(key, choice.number);
			events.saved(answer);
			if (answer.access === "none" || !answer.canShare) end(answer, key === me ? "self" : "changed");
		} catch (error) {
			if (stopped) return;
			// Gone for the person: nothing queued can be saved, newer choices or not.
			if (error instanceof ApiError && error.status === 404) return void end(null);
			if (error instanceof ApiError && error.status === 403 && !(await stillShares())) return;
			// A newer choice for this row goes next, and this one is not taken back or reported.
			if (!forget(key, choice.number)) return;
			events.failed(failure(key, choice.value, before, error));
		}
	}

	/** After a 403: whether the person can still share. When they can't, Share ends. */
	async function stillShares() {
		try {
			const fresh = await api.refresh();
			if (stopped) return false;
			if (fresh.canShare) return true;
			saved.value = fresh;
			events.saved(fresh);
			end(fresh, "changed");
			return false;
		} catch (error) {
			if (stopped) return false;
			if (error instanceof ApiError && error.status === 404) {
				end(null);
				return false;
			}
			// Offline: say what failed, as for any refusal.
			return true;
		}
	}

	function send(key: string, value: MemberAccess | OrgAccess | null) {
		if (key === GENERAL) return api.setOrgAccess(value === "ask" ? "ask" : "none");
		if (value === null) return api.removeMember(key);
		return api.setMember(key, value === "edit" ? "edit" : "ask");
	}

	/** Drops the row's choice when it is this one or older: true when it did. */
	function forget(key: string, number: number) {
		if (key === GENERAL) {
			if (!wantedOrg.value || wantedOrg.value.number > number) return false;
			wantedOrg.value = null;
			return true;
		}
		const choice = wanted.get(key);
		if (!choice || choice.number > number) return false;
		wanted.delete(key);
		return true;
	}

	function end(answer: WorkspaceDetail | null, why: "self" | "changed" = "changed") {
		stopped = true;
		queue.length = 0;
		wanted.clear();
		wantedOrg.value = null;
		if (sessions.get(saved.value.id) === session) sessions.delete(saved.value.id);
		if (answer) events.lost(answer, why);
		else events.gone();
	}

	function failure(key: string, value: MemberAccess | OrgAccess | null, before: MemberAccess | null, error: unknown) {
		const why = error instanceof ApiError && error.status < 500 ? error.message : "Try again.";
		if (key === GENERAL) return `General access could not be changed. ${why}`;
		const person = saved.value.members?.find((member: Member) => member.id === key) ?? added.get(key);
		const name = person ? displayName(person.name, person.email) : "This person";
		if (value === null) return `${name} could not be removed. ${why}`;
		return before === null ? `${name} could not be added. ${why}` : `${name}'s role could not be changed. ${why}`;
	}

	function busy() {
		return !stopped && (running || queue.length > 0 || wanted.size > 0 || wantedOrg.value !== null);
	}

	function attach(nextApi: SharingApi, nextEvents: SharingEvents) {
		api = nextApi;
		events = nextEvents;
	}

	const view = {
		saved,
		members,
		orgAccess,
		add,
		setRole: (userId: string, access: MemberAccess) => choose(userId, access),
		remove: (userId: string) => choose(userId, null),
		setGeneral,
	};
	const session = { view, busy, attach };
	return session;
}
