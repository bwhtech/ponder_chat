import { z } from "zod";

/**
 * What the model sees of run_python: its name, description and input. Kept apart from
 * tool.ts because the chat workflow imports it, and workflow code cannot load Node modules.
 */
export const RUN_PYTHON = "run_python";
export const RUN_TIMEOUT_MS = 60_000;

export const runPythonInput = z.object({
	code: z
		.string()
		.describe("Python 3.14. Read inputs from /work/inputs; write files to show the person to /work/outputs; print what you need to read."),
	inputs: z
		.array(
			z.object({
				name: z.string().describe("A short snake_case name; the file is saved as /work/inputs/<name>.<ext>"),
				file_id: z.string().describe("The file id of a file the person attached, as its message names it"),
			}),
		)
		.default([])
		.describe("Attached files to put in /work/inputs before the code runs."),
});

export type RunPythonInput = z.infer<typeof runPythonInput>;

export const RUN_PYTHON_DESCRIPTION =
	"Run Python to calculate, analyse data or make a file: statistics, cleaning and joining data, a chart as an image, " +
	"an Excel or CSV file to download, or reading a spreadsheet or CSV the person attached. " +
	"Installed: pandas, numpy, matplotlib, seaborn, scipy, scikit-learn, statsmodels, sympy, networkx, openpyxl, xlrd, pillow, " +
	"beautifulsoup4, lxml, pyyaml, regex, tabulate. Nothing else can be installed, and there is no internet. " +
	"Variables, imports and files in /work stay between runs in this chat. " +
	"Files the code writes to /work/outputs are shown to the person; images show in the chat. " +
	`A run stops after ${RUN_TIMEOUT_MS / 1000} seconds. Not for arithmetic you can do yourself.`;

