import { registerExport } from "../../lib/export-markdown";
import UseSkillPart from "../../skills/UseSkillPart";
import { registerToolRenderer } from "../tool-renderers";
import RunPythonPart from "./RunPythonPart";
import WebToolPart, { webToolLine } from "./WebToolPart";

/** This slice's extension points: its tool renderers, and Export as Markdown in each thread's menu. */

// A Python run shows its code, what it printed, and the files it made.
// Searches and page reads are one line each, so they fold with the steps around them.
// A skill Ponder chose (use_skill) stays a line of its own, so the person sees which skill shaped the reply.
registerToolRenderer("run_python", { component: RunPythonPart });
registerToolRenderer("web_search", { component: WebToolPart, foldable: true, line: webToolLine });
registerToolRenderer("web_fetch", { component: WebToolPart, foldable: true, line: webToolLine });
registerToolRenderer("use_skill", { component: UseSkillPart });
registerExport();
