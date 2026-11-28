<script setup lang="ts">
import { Button, Dialog, Dropdown } from "frappe-ui";
import { computed, h, onBeforeUnmount, ref } from "vue";
import { displayName } from "../../shared/display-name";
import { me } from "../account";
import { dialog } from "../dialogs";
import { toast } from "../toasts";
import { dialogTitle, GENERAL_ACCESS, generalAccessNote, ROLE_LABELS, useFrameFocus, workspaceDialog, type WorkspaceDialogRequest } from "./dialogs";
import PeoplePicker from "./PeoplePicker.vue";
import ShareRow from "./ShareRow.vue";
import { useSharing } from "./sharing";
import { plural } from "../numbers";
import {
	fetchWorkspace,
	isAdmin,
	removeMember,
	removeTeam,
	setMember,
	setOrgAccess,
	setTeam,
	workspaceHref,
	type Member,
	type MemberAccess,
	type OrgAccess,
	type Person,
	type TeamMatch,
	type WorkspaceTeam,
} from "./store";

/**
 * Share, as Google Docs has it: the people and teams with access, each with their own role, then
 * General access, which an admin can open to everyone in the organisation. Everyone who can edit
 * adds people and teams, changes their roles and removes them; nobody changes the owner. A team's
 * role is every member's. An archived team gives no access: its row is greyed out and can only
 * be removed. Each change applies at
 * once and is saved in the background (sharing.ts), so the footer has Copy link and Done, not
 * Save. Opening to everyone, or closing it, asks first, in place. Removing yourself, or giving
 * yourself Can ask, asks first too, when it takes your right to share: the dialog then closes.
 */
const props = defineProps<{ request: Extract<WorkspaceDialogRequest, { kind: "share" }> }>();
const open = computed({ get: () => workspaceDialog.open, set: (value) => (workspaceDialog.open = value) });
const workspace = props.request.workspace;
const myId = computed(() => me.value?.user.id ?? "");
const myName = computed(() => (me.value ? displayName(me.value.user.name, me.value.user.email) : "You"));

const error = ref("");
/**
 * This dialog is open. A change still on its way when it closed answers to the page, and to a
 * toast; it never closes or writes in a dialog opened after it.
 */
let shown = true;
onBeforeUnmount(() => (shown = false));
const showing = () => shown && open.value;
function close() {
	if (showing()) open.value = false;
}
const sharing = useSharing(
	workspace,
	{
		setMember: (userId, access) => setMember(workspace.id, userId, access),
		removeMember: (userId) => removeMember(workspace.id, userId),
		setOrgAccess: (orgAccess) => setOrgAccess(workspace.id, orgAccess),
		setTeam: (teamId, access) => setTeam(workspace.id, teamId, access),
		removeTeam: (teamId) => removeTeam(workspace.id, teamId),
		refresh: () => fetchWorkspace(workspace.id),
	},
	{
		saved: (answer) => props.request.onSaved(answer),
		lost: (_, why) => {
			close();
			// Someone else changed your role: say why Share went.
			if (why === "changed") toast.info(`You can no longer share “${workspace.name}”.`);
		},
		gone: () => {
			close();
			props.request.onGone();
		},
		failed: (message) => (showing() ? (error.value = message) : toast.error(message)),
	},
	me.value?.user.id ?? "",
);
useFrameFocus();

const members = sharing.members;
const teams = sharing.teams;
const orgAccess = sharing.orgAccess;
const canChangeGeneral = computed(() => sharing.saved.value.canChangeOrgAccess);
const excluded = computed(() => [workspace.owner.id, ...members.value.map((member) => member.id)]);
const excludedTeams = computed(() => teams.value.map((team) => team.id));
const nameOf = (person: Person) => displayName(person.name, person.email);

/** A person or a team added while everyone can ask already is there to edit it. */
function pick(person: Person) {
	error.value = "";
	sharing.add(person, orgAccess.value === "ask" ? "edit" : "ask");
}

function pickTeam(team: TeamMatch) {
	error.value = "";
	sharing.addTeam(team, orgAccess.value === "ask" ? "edit" : "ask");
}

function choose(member: Member, access: MemberAccess) {
	if (access === member.access) return;
	error.value = "";
	if (member.id !== myId.value || access === "edit" || keepsSharing()) return sharing.setRole(member.id, access);
	dialog.confirm({
		title: "Change your role to Can ask?",
		message: `You will still ask in “${workspace.name}”, but you will no longer change it or share it.`,
		confirmLabel: "Change",
		onConfirm: () => sharing.setRole(member.id, access),
	});
}

function remove(member: Member) {
	error.value = "";
	if (member.id !== myId.value || keepsSharing()) return sharing.remove(member.id);
	const asks = orgAccess.value === "ask";
	dialog.danger({
		title: "Remove yourself?",
		message: asks
			? `You will still ask in “${workspace.name}”, as everyone can, but you will no longer change it or share it.`
			: `You will no longer see “${workspace.name}” or its sources. Your chats there stay yours.`,
		confirmLabel: "Remove",
		onConfirm: () => sharing.remove(member.id),
	});
}

/** An admin edits a workspace open to everyone whatever their own role: their change to it takes nothing from them. */
function keepsSharing() {
	return isAdmin.value && orgAccess.value === "ask";
}

const check = (on: boolean) => ({ suffix: () => (on ? h("span", { class: "lucide-check size-4 shrink-0 text-ink-gray-7" }) : null) });

function roleMenu(member: Member) {
	const role = (access: MemberAccess, description: string) => ({
		label: ROLE_LABELS[access],
		description,
		onClick: () => choose(member, access),
		slots: check(member.access === access),
	});
	return [
		{ group: "Role", hideLabel: true, options: [role("ask", "Asks with its sources"), role("edit", "Also changes and shares it")] },
		{ group: "Remove", hideLabel: true, options: [{ label: "Remove", theme: "red" as const, onClick: () => remove(member) }] },
	];
}

function teamMenu(team: WorkspaceTeam) {
	const role = (access: MemberAccess, description: string) => ({
		label: ROLE_LABELS[access],
		description,
		onClick: () => {
			error.value = "";
			if (access !== team.access) sharing.setTeamRole(team.id, access);
		},
		slots: check(team.access === access),
	});
	return [
		{ group: "Role", hideLabel: true, options: [role("ask", "Its members ask with its sources"), role("edit", "Its members also change and share it")] },
		{ group: "Remove", hideLabel: true, options: [{ label: "Remove", theme: "red" as const, onClick: () => removeTeamRow(team) }] },
	];
}

function removeTeamRow(team: WorkspaceTeam) {
	error.value = "";
	sharing.removeTeam(team.id);
}

const teamName = (team: WorkspaceTeam) => (team.archived ? `${team.name} (archived)` : team.name);

/** General access, chosen but not yet confirmed: opening it to everyone, or closing it, asks first. */
const pendingGeneral = ref<OrgAccess | null>(null);
const generalMenu = computed(() =>
	(["none", "ask"] as const).map((value) => ({
		label: GENERAL_ACCESS[value].label,
		icon: GENERAL_ACCESS[value].icon,
		onClick: () => {
			error.value = "";
			pendingGeneral.value = value === orgAccess.value ? null : value;
		},
		slots: check(orgAccess.value === value),
	})),
);
const CONFIRM = {
	ask: { text: "Everyone in the organisation sees it in their sidebar and can ask from its sources.", action: "Open to everyone" },
	none: { text: "Everyone not listed above loses access. Their chats stay theirs.", action: "Remove their access" },
} as const;

function confirmGeneral() {
	if (pendingGeneral.value) sharing.setGeneral(pendingGeneral.value);
	pendingGeneral.value = null;
}

/** Copy link: the page's address. A person without access sees "not found" there, so it shows nothing. */
const COPIED_MS = 2000;
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copyLink() {
	try {
		await navigator.clipboard.writeText(new URL(workspaceHref(workspace.slug), location.origin).href);
	} catch {
		error.value = "The link could not be copied.";
		return;
	}
	copied.value = true;
	clearTimeout(copiedTimer);
	copiedTimer = setTimeout(() => (copied.value = false), COPIED_MS);
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<template>
	<Dialog v-model:open="open" :title="dialogTitle(request)" size="lg">
		<div class="space-y-4">
			<PeoplePicker :exclude="excluded" :exclude-teams="excludedTeams" @pick="pick" @pick-team="pickTeam" />

			<section class="space-y-1" aria-labelledby="share-people-label">
				<h4 id="share-people-label" class="flex h-7 items-center text-sm text-ink-gray-6">People with access</h4>
				<!-- A person or team added fades in under the others; one removed fades out, and the rows under it close up. -->
				<TransitionGroup
					tag="ul"
					class="relative"
					aria-labelledby="share-people-label"
					enter-active-class="transition-opacity duration-150 ease-out-strong motion-reduce:transition-none"
					enter-from-class="opacity-0"
					leave-active-class="absolute inset-x-0 transition-opacity duration-150 ease-out-strong motion-reduce:transition-none"
					leave-to-class="opacity-0"
					move-class="transition-transform duration-200 ease-out-strong motion-reduce:transition-none"
				>
					<ShareRow
						key="owner"
						:avatar="nameOf(workspace.owner)"
						:name="workspace.owner.id === myId ? 'You' : nameOf(workspace.owner)"
						:email="workspace.owner.id === myId ? undefined : workspace.owner.email"
						owner
					/>
					<ShareRow
						v-for="member in members"
						:key="member.id"
						:avatar="member.id === myId ? myName : nameOf(member)"
						:name="member.id === myId ? 'You' : nameOf(member)"
						:email="member.id === myId ? undefined : member.email"
						data-slot="workspace-member"
					>
						<!-- The menus' text is the Button's slot, not its `label`: frappe-ui makes `label` the aria-label too. -->
						<Dropdown :options="roleMenu(member)" align="end">
							<Button
								variant="ghost"
								class="touch-target w-28 !justify-between"
								icon-right="lucide-chevron-down"
								:aria-label="`What ${member.id === myId ? 'you' : nameOf(member)} can do: ${ROLE_LABELS[member.access]}`"
							>
								{{ ROLE_LABELS[member.access] }}
							</Button>
						</Dropdown>
					</ShareRow>
					<ShareRow
						v-for="team in teams"
						:key="`team:${team.id}`"
						icon="lucide-users"
						:name="teamName(team)"
						:email="plural(team.memberCount, 'member')"
						:muted="team.archived"
						data-slot="workspace-team"
					>
						<!-- An archived team gives no access, so it has only Remove. -->
						<Button
							v-if="team.archived"
							variant="ghost"
							class="touch-target w-28 !justify-start !text-ink-gray-6"
							:aria-label="`Remove ${teamName(team)}`"
							@click="removeTeamRow(team)"
						>
							Remove
						</Button>
						<Dropdown v-else :options="teamMenu(team)" align="end">
							<Button
								variant="ghost"
								class="touch-target w-28 !justify-between"
								icon-right="lucide-chevron-down"
								:aria-label="`What ${team.name} can do: ${ROLE_LABELS[team.access]}`"
							>
								{{ ROLE_LABELS[team.access] }}
							</Button>
						</Dropdown>
					</ShareRow>
				</TransitionGroup>
			</section>

			<section class="space-y-1" aria-labelledby="share-general-label" data-slot="general-access">
				<h4 id="share-general-label" class="flex h-7 items-center text-sm text-ink-gray-6">General access</h4>
				<div class="flex items-start gap-x-2.5">
					<span class="mt-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-gray-2 text-ink-gray-6" aria-hidden="true">
						<span :class="[GENERAL_ACCESS[orgAccess].icon, 'size-3']" />
					</span>
					<div class="min-w-0 flex-1">
						<Dropdown v-if="canChangeGeneral" :options="generalMenu" align="start">
							<Button
								variant="ghost"
								class="touch-target -ml-2"
								icon-right="lucide-chevron-down"
								:aria-label="`General access: ${GENERAL_ACCESS[orgAccess].label}`"
							>
								{{ GENERAL_ACCESS[orgAccess].label }}
							</Button>
						</Dropdown>
						<p v-else class="flex h-7 items-center text-base text-ink-gray-8">{{ GENERAL_ACCESS[orgAccess].label }}</p>
						<!-- Says what General access means, and what a change will do before it is made. -->
						<div aria-live="polite">
							<div v-if="pendingGeneral" class="space-y-2 pb-1" data-slot="general-access-confirm">
								<p class="text-p-sm text-ink-gray-8">{{ CONFIRM[pendingGeneral].text }}</p>
								<div class="flex flex-wrap gap-2">
									<Button label="Cancel" @click="pendingGeneral = null" />
									<Button
										:variant="pendingGeneral === 'ask' ? 'solid' : 'subtle'"
										:theme="pendingGeneral === 'ask' ? 'gray' : 'red'"
										:label="CONFIRM[pendingGeneral].action"
										@click="confirmGeneral"
									/>
								</div>
							</div>
							<p v-else class="text-p-sm text-ink-gray-6">{{ generalAccessNote(orgAccess, canChangeGeneral) }}</p>
						</div>
					</div>
					<span v-if="orgAccess === 'ask'" class="hidden h-7 w-28 shrink-0 items-center px-2 text-base text-ink-gray-6 sm:flex">Can ask</span>
				</div>
			</section>

			<p v-if="error" role="alert" class="text-p-sm text-ink-red-6" data-slot="share-error">{{ error }}</p>

			<div class="flex items-center justify-between gap-2 pt-2">
				<Button :icon-left="copied ? 'lucide-check' : 'lucide-link'" :label="copied ? 'Link copied' : 'Copy link'" @click="copyLink" />
				<span class="sr-only" aria-live="polite">{{ copied ? "Link copied" : "" }}</span>
				<Button variant="solid" theme="gray" label="Done" @click="open = false" />
			</div>
		</div>
	</Dialog>
</template>
