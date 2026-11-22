<script setup lang="ts">
import { Button, Skeleton } from "frappe-ui";
import { me, signOut } from "../account";
import DialogFrame from "../DialogFrame.vue";
import { credits } from "../numbers";
import MemoryRowsSkeleton from "./MemoryRowsSkeleton.vue";
import PanelHeader from "./PanelHeader.vue";
import { creditsNote, MEMORY_INTRO, MEMORY_TABS, SETTINGS_TABS, settings, USAGE_INTRO, type SettingsTab } from "./state";
import UsageSkeleton from "./UsageSkeleton.vue";
import UsageToday from "./UsageToday.vue";

/**
 * Settings (SettingsModal.vue) while its code arrives: the same dialog, the same sidebar, and
 * the open tab. Account has everything it shows already, and Usage its first card; Usage, Memory
 * and Connectors show rows shaped like theirs, as their own loading does (UsagePanel.vue,
 * MemoryPanel.vue, connectors/ConnectorsPanel.vue).
 * Nothing moves when the dialog takes its place. The markup copies frappe-ui's SettingsDialog,
 * and Memory's tabs copy frappe-ui's TabButtons, with Memories chosen.
 */
function pick(tab: SettingsTab) {
	settings.tab = tab;
	settings.connector = null;
}
</script>

<template>
	<DialogFrame v-if="settings.open" label="Settings" size="max-w-4xl" @close="settings.open = false">
		<div
			data-orientation="vertical"
			class="relative flex h-[100dvh] min-h-0 w-screen flex-col overflow-hidden sm:h-[min(860px,calc(100vh-8rem))] sm:min-h-[560px] sm:w-auto sm:flex-row"
		>
			<div class="flex max-h-[38vh] w-full shrink-0 flex-col overflow-y-auto border-b border-outline-gray-1 bg-surface-sidebar p-2 sm:max-h-none sm:w-[220px] sm:border-b-0 sm:border-r">
				<div class="space-y-4">
					<div class="[&>div:first-child]:text-xs-medium">
						<div class="flex h-7 items-center px-2 text-base text-ink-gray-5">Settings</div>
						<div class="flex flex-col gap-0.5">
							<button
								v-for="tab in SETTINGS_TABS"
								:key="tab.value"
								type="button"
								:data-state="settings.tab === tab.value ? 'active' : 'inactive'"
								class="flex h-7 w-full items-center gap-2 rounded-4 px-2 text-left !text-sm text-ink-gray-7 data-[state=active]:bg-surface-elevation-3 data-[state=active]:shadow-sm data-[state=inactive]:hover:bg-surface-gray-2 [@media(pointer:coarse)]:!h-11"
								@click="pick(tab.value)"
							>
								<span :class="[tab.icon, 'size-4 text-ink-gray-6']" aria-hidden="true" />
								<span class="min-w-0 flex-1 truncate">{{ tab.label }}</span>
							</button>
						</div>
					</div>
				</div>
			</div>
			<div class="flex min-h-0 flex-1 flex-col">
				<template v-if="settings.tab === 'account'">
					<PanelHeader title="Account" />
					<div class="min-h-0 flex-1 overflow-hidden px-4 pb-16 sm:px-12">
						<div v-if="me" class="divide-y divide-outline-gray-1">
							<!-- frappe-ui's SettingsRow. -->
							<div class="flex items-center gap-8 py-3.5">
								<div class="min-w-0 flex-1">
									<div class="block text-base-medium leading-tighter text-ink-gray-8">Signed in as</div>
									<div class="mt-1 text-base leading-5 text-ink-gray-6">{{ me.user.email }}</div>
								</div>
								<div class="flex shrink-0 items-start justify-end">
									<Button icon-left="lucide-log-out" label="Sign out" @click="signOut" />
								</div>
							</div>
							<div class="flex items-center gap-8 py-3.5">
								<div class="min-w-0 flex-1">
									<div class="block text-base-medium leading-tighter text-ink-gray-8">Daily credits</div>
									<div class="mt-1 text-base leading-5 text-ink-gray-6">{{ creditsNote(me.credits) }}</div>
								</div>
								<div class="flex shrink-0 items-start justify-end">
									<span class="whitespace-nowrap text-sm tabular-nums text-ink-gray-6">{{ credits(me.credits.remaining) }} left today</span>
								</div>
							</div>
						</div>
					</div>
				</template>
				<template v-else-if="settings.tab === 'usage'">
					<PanelHeader title="Usage" :description="USAGE_INTRO" />
					<div class="min-h-0 flex-1 overflow-hidden px-4 pb-16 sm:px-12">
						<div class="space-y-4 pt-5">
							<UsageToday v-if="me" :credits="me.credits" />
							<UsageSkeleton />
						</div>
					</div>
				</template>
				<template v-else-if="settings.tab === 'memory'">
					<PanelHeader title="Memory" :description="MEMORY_INTRO" />
					<div class="min-h-0 flex-1 overflow-hidden px-4 pb-16 sm:px-12">
						<div class="space-y-5 pt-5">
							<div>
								<div class="relative isolate inline-flex shrink-0 items-center gap-1 rounded-4 bg-surface-gray-2 p-px" aria-hidden="true">
									<span
										v-for="(tab, index) in MEMORY_TABS"
										:key="tab.value"
										class="inline-flex h-6.5 items-center justify-center whitespace-nowrap rounded-[7px] px-2 py-[5px] text-sm leading-[16.1px]"
										:class="index === 0 ? 'bg-surface-elevation-3 text-ink-gray-8 shadow-base' : 'text-ink-gray-5'"
									>
										{{ tab.label }}
									</span>
								</div>
							</div>
							<MemoryRowsSkeleton />
						</div>
					</div>
				</template>
				<template v-else>
					<PanelHeader title="Connectors" description="Apps that Ponder can use for you." />
					<div class="min-h-0 flex-1 overflow-hidden px-4 pb-16 sm:px-12">
						<div class="divide-y divide-outline-gray-1" aria-label="Loading connectors">
							<div v-for="n in 3" :key="n" class="flex items-center gap-3 py-3">
								<Skeleton class="size-8 rounded-4" />
								<div class="flex-1 space-y-1.5">
									<Skeleton class="h-3.5 w-28 rounded-4" />
									<Skeleton class="h-3 w-52 rounded-4" />
								</div>
								<Skeleton class="h-5 w-9 rounded-full" />
							</div>
						</div>
					</div>
				</template>
			</div>
			<Button
				data-slot="settings-close"
				class="absolute right-2 top-2 z-10 after:absolute after:inset-0 after:content-[''] sm:right-8 sm:top-9 [@media(pointer:coarse)]:after:-inset-2"
				variant="ghost"
				icon="lucide-x"
				aria-label="Close settings"
				@click="settings.open = false"
			/>
		</div>
	</DialogFrame>
</template>
