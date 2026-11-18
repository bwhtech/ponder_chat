// What workspace components expose to their parents (defineExpose). As types in a .ts
// file, ESLint can read them: it sees a .vue import only as a component (vue-shim.d.ts).

/** WorkspaceDocuments.vue: uploads files dropped anywhere on the workspace's sections (WorkspaceAbout.vue). */
export type DocumentsHandle = { upload: (files: File[]) => Promise<void> };

/** WorkspaceComposer.vue: puts focus in the message box, once the setup is done (WorkspacePage.vue). */
export type ComposerHandle = { focus: () => void };

/** WorkspaceSetup.vue: whether focus is on the setup cards, or will come back to one from its dialog or file picker. */
export type SetupHandle = { holdsFocus: () => boolean };

/** WorkspaceOnboarding.vue and WorkspaceAbout.vue: uploads files dropped on the page outside their own drop areas (WorkspacePage.vue). */
export type UploadHandle = { upload: (files: File[]) => Promise<void> };

/** WorkspaceTitle.vue: starts a rename, from the heading's menu. */
export type TitleHandle = { start: () => Promise<void> };
