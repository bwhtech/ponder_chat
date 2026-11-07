/// <reference types="vite/client" />

// frappe-ui's code editor imports every language it knows; the skill editor installs only
// Markdown and YAML. frappe-ui's Vite plugin leaves out the rest, and these keep the
// typecheck from asking for them.
declare module "@codemirror/lang-json";
declare module "@codemirror/lang-python";
declare module "@codemirror/lang-sass";
declare module "@codemirror/lang-sql";
declare module "@codemirror/lang-xml";
