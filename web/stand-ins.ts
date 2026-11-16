/**
 * What answers a tap at once while the code it opens is on its way: shapes of Settings, Memory,
 * the side panel and the confirm dialogs, and the note that /admin is opening. One small chunk,
 * which the page fetches as soon as it has drawn (Workspace.vue), so it never slows the first
 * screen and is here long before the chats' menus are.
 */
export { default as DialogPlaceholder } from "./DialogPlaceholder.vue";
export { default as MemoryPlaceholder } from "./MemoryPlaceholder.vue";
export { default as PageOpening } from "./PageOpening.vue";
export { default as SettingsPlaceholder } from "./settings/SettingsPlaceholder.vue";
export { default as PanelPlaceholder } from "./side-panel/PanelPlaceholder.vue";
