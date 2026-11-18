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
 * A change the server refuses is taken back, with a line that says why, unless the person
 * changed that row again meanwhile: then their newer choice is sent instead. Each change is
 * its own request (PUT or DELETE /members/:userId, PUT /access), so two people changing
 * different people at once both keep their change.
 */
export type SharingApi = {
	setMember: (userId: string, access: MemberAccess) => Promise<WorkspaceDetail>;
	removeMember: (userId: string) => Promise<WorkspaceDetail>;
	setOrgAccess: (orgAccess: OrgAccess) => Promise<WorkspaceDetail>;
};

export type SharingEvents = {
	/** Each answer, in order: the workspace as the person sees it now. */
	saved: (workspace: WorkspaceDetail) => void;
	/** The person can no longer share it: they removed themselves, or someone else changed their role. Nothing more is sent. */
	lost: (workspace: WorkspaceDetail) => void;
	/** The workspace is gone for this person: deleted, or they were removed. Nothing more is sent. */
	gone: () => void;
	/** A change was refused and taken back: what to say. */
	failed: (message: string) => void;
};

/** The row of General access in the queue: member rows are keyed by the person's id. */
const GENERAL = "\u0000general";

export function useSharing(initial: WorkspaceDetail, api: SharingApi, events: SharingEvents) {
	/** The last answer. */
	const saved = shallowRef(initial);
	/** What the person chose for a person, while it differs from the last answer or is on its way: null to remove them. */
	const wanted = reactive(new Map<string, MemberAccess | null>());
	const wantedOrg = ref<OrgAccess | null>(null);
	/** People added here, by id, until an answer has them. */
	const added = new Map<string, Person>();
	/** The rows' order: as the dialog opened, then each person in the order they were added. Nothing moves while it is open. */
	const order = ref<string[]>((initial.members ?? []).map((member: Member) => member.id));
	const queue: string[] = [];
	let running = false;
	let stopped = false;

	const members = computed<Member[]>(() => {
		const byId = new Map<string, Member>((saved.value.members ?? []).map((member: Member) => [member.id, member]));
		const ids = [...order.value, ...[...byId.keys()].filter((id) => !order.value.includes(id))];
		return ids.flatMap((id) => {
			const person = byId.get(id) ?? added.get(id);
			const access = wanted.has(id) ? wanted.get(id) : byId.get(id)?.access;
			return person && access ? [{ id, name: person.name, email: person.email, access }] : [];
		});
	});
	const orgAccess = computed<OrgAccess>(() => wantedOrg.value ?? saved.value.orgAccess);

	function add(person: Person, access: MemberAccess) {
		added.set(person.id, person);
		if (!order.value.includes(person.id)) order.value = [...order.value, person.id];
		choose(person.id, access);
	}

	function setRole(userId: string, access: MemberAccess) {
		choose(userId, access);
	}

	function remove(userId: string) {
		choose(userId, null);
	}

	function setGeneral(value: OrgAccess) {
		wantedOrg.value = value;
		enqueue(GENERAL);
	}

	function choose(userId: string, access: MemberAccess | null) {
		wanted.set(userId, access);
		enqueue(userId);
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
	}

	function savedAccess(userId: string) {
		return saved.value.members?.find((member: Member) => member.id === userId)?.access ?? null;
	}

	async function write(key: string) {
		if (key === GENERAL) return writeGeneral();
		if (!wanted.has(key)) return;
		const target = wanted.get(key) ?? null;
		if (target === savedAccess(key)) return void wanted.delete(key);
		try {
			apply(target === null ? await api.removeMember(key) : await api.setMember(key, target));
		} catch (error) {
			// A newer choice for this person is queued: it goes next, and this one is not taken back.
			if (wanted.get(key) === target) {
				wanted.delete(key);
				fail(error, memberFailure(key, target));
			}
		}
		if (wanted.has(key) && wanted.get(key) === savedAccess(key)) wanted.delete(key);
	}

	async function writeGeneral() {
		const target = wantedOrg.value;
		if (target === null) return;
		if (target === saved.value.orgAccess) return void (wantedOrg.value = null);
		try {
			apply(await api.setOrgAccess(target));
		} catch (error) {
			if (wantedOrg.value === target) {
				wantedOrg.value = null;
				fail(error, "General access could not be changed.");
			}
		}
		if (wantedOrg.value === saved.value.orgAccess) wantedOrg.value = null;
	}

	function apply(answer: WorkspaceDetail) {
		saved.value = answer;
		if (answer.access === "none" || !answer.canShare) {
			stop();
			events.saved(answer);
			return events.lost(answer);
		}
		events.saved(answer);
	}

	function fail(error: unknown, what: string) {
		if (error instanceof ApiError && error.status === 404) {
			stop();
			return events.gone();
		}
		const why = error instanceof ApiError && error.status < 500 ? error.message : "Try again.";
		events.failed(`${what} ${why}`);
	}

	function stop() {
		stopped = true;
		queue.length = 0;
		wanted.clear();
		wantedOrg.value = null;
	}

	function memberFailure(userId: string, target: MemberAccess | null) {
		const person = saved.value.members?.find((member: Member) => member.id === userId) ?? added.get(userId);
		const name = person ? displayName(person.name, person.email) : "This person";
		if (target === null) return `${name} could not be removed.`;
		return savedAccess(userId) === null ? `${name} could not be added.` : `${name}'s role could not be changed.`;
	}

	return { saved, members, orgAccess, add, setRole, remove, setGeneral, busy: () => running };
}
