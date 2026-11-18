// What two workspace components expose to their parents (defineExpose). As types in a .ts
// file, ESLint can read them: it sees a .vue import only as a component (vue-shim.d.ts).

/** WorkspaceDocuments.vue: uploads files dropped anywhere on the workspace's aside. */
export type DocumentsHandle = { upload: (files: File[]) => Promise<void> };

/** WorkspaceTitle.vue: starts a rename, from the heading's menu. */
export type TitleHandle = { start: () => Promise<void> };

/** WorkspaceComposer.vue: a first question put in the box (WorkspaceStarters.vue), to edit or send. */
export type ComposerHandle = { fill: (text: string) => void };
