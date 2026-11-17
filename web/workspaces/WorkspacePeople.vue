<script setup lang="ts">
import { Avatar, Skeleton } from "frappe-ui";
import { computed } from "vue";
import { displayName } from "../../shared/display-name";
import { me } from "../account";
import { count } from "../numbers";
import type { Member, WorkspaceDetail } from "./store";

/**
 * Who can use the workspace, in its side panel: each person with what they can do. The
 * owner sees every member. A member sees the owner and themself, and how many others there
 * are: the server sends the members only to whoever can change them. Share, in the page's
 * header, changes them.
 */
const props = defineProps<{ detail?: WorkspaceDetail }>();

type Row = { key: string; name: string; avatar: string; access: string; member?: boolean };
const ACCESS_LABELS = { ask: "Can ask", edit: "Can edit", owner: "Owner" } as const;

const myName = computed(() => (me.value ? displayName(me.value.user.name, me.value.user.email) : "You"));

const rows = computed<Row[]>(() => {
	const detail = props.detail;
	if (!detail || detail.kind === "org") return [];
	const owner = detail.access === "owner" ? you("owner") : person(detail.owner.id, detail.owner, "owner");
	if (detail.members) return [owner, ...detail.members.map((member: Member) => ({ ...person(member.id, member, member.access), member: true }))];
	return detail.access === "none" ? [owner] : [owner, you(detail.access)];
});

/** Members a member can't see by name. */
const others = computed(() => {
	const detail = props.detail;
	if (!detail || detail.kind === "org" || detail.members) return 0;
	return Math.max(0, detail.memberCount - 1);
});

function person(id: string, who: { name: string; email: string }, access: keyof typeof ACCESS_LABELS): Row {
	const name = displayName(who.name, who.email);
	return { key: id, name, avatar: name, access: ACCESS_LABELS[access] };
}

function you(access: keyof typeof ACCESS_LABELS): Row {
	return { key: "you", name: "You", avatar: myName.value, access: ACCESS_LABELS[access] };
}
</script>

<template>
	<section class="space-y-3" aria-labelledby="workspace-people-heading" data-slot="workspace-sharing">
		<h2 id="workspace-people-heading" class="flex h-7 items-center text-base-semibold text-ink-gray-9">People</h2>
		<div v-if="!detail" class="flex h-8 items-center gap-2.5 text-sm" aria-busy="true">
			<Skeleton class="size-5 rounded-full" />
			<span class="flex h-[1lh] items-center"><Skeleton class="h-3 w-32 rounded-4" /></span>
		</div>
		<ul v-else>
			<li v-if="detail.kind === 'org'" class="flex h-8 items-center gap-2.5">
				<span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true"><span class="lucide-building-2 size-4 text-ink-gray-5" /></span>
				<span class="min-w-0 flex-1 truncate text-sm text-ink-gray-8">Everyone in the organisation</span>
			</li>
			<li v-for="row in rows" :key="row.key" class="flex h-8 items-center gap-2.5" :data-slot="row.member ? 'workspace-member' : undefined">
				<Avatar :label="row.avatar" size="sm" class="shrink-0" />
				<span class="min-w-0 flex-1 truncate text-sm text-ink-gray-8">{{ row.name }}</span>
				<span class="shrink-0 text-sm text-ink-gray-6">{{ row.access }}</span>
			</li>
			<li v-if="others" class="flex h-8 items-center gap-2.5">
				<span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true"><span class="lucide-users size-4 text-ink-gray-5" /></span>
				<span class="min-w-0 flex-1 truncate text-sm text-ink-gray-6">{{ others === 1 ? "1 more person" : `${count(others)} more people` }}</span>
			</li>
		</ul>
	</section>
</template>
