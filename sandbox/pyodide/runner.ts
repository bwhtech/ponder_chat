/**
 * Runs one piece of Python in Pyodide (CPython compiled to WebAssembly), inside a Deno
 * process with no permissions except reading Pyodide and the vendored packages. The
 * server starts a new process for each run (server/python/pyodide.ts), so a run cannot
 * see another run, and a kill ends everything it started.
 *
 * Adapted from LangChain's pyodide-sandbox (libs/pyodide-sandbox-js/main.ts, MIT, see
 * LICENSE.langchain), which adapted pyodide-worker-runner and pydantic-ai's
 * mcp-run-python. Kept from it: a fresh Deno process per run, deny-by-default
 * permissions, packages loaded from the code's imports, and state carried between runs
 * as a dill snapshot of the globals that the caller stores. Changed:
 *
 * - The request comes on stdin, not in argv, so code and files are not limited by argv size.
 * - No network and no write access: packages come from the cache that setup.sh fills.
 *   LangChain lets runs write to node_modules, so one run could change the packages of the next.
 * - Files: inputs are written to /work/inputs, and files in /work/outputs come back.
 *   Files elsewhere in /work are kept with the state.
 * - The reply line starts with a nonce from the request. Code can write to stdout itself,
 *   so the server takes only the line with the nonce.
 * - Python cannot see JavaScript globals (`jsglobals` is empty), and no host folder is
 *   mounted: the vendored packages are copied into memory. Both are walls behind Deno's
 *   permissions. (A write to a mounted folder was refused by Deno, but the refusal ended the run.)
 * - State keeps the variables as a dill dump of a dict, plus the modules they were
 *   imported as. LangChain's dill session load into __main__ fails in this Pyodide.
 */
import { loadPyodide, type PyodideInterface } from "pyodide";

type InFile = { path: string; base64: string };
type Request = {
	nonce: string;
	code: string;
	/** Inputs, written to /work/inputs before the code runs. */
	files?: InFile[];
	/** What an earlier run in this thread left: its globals and its files in /work. */
	state?: { globals?: string; imports?: string[]; files?: InFile[] };
	limits?: { maxOutputFiles?: number; maxOutputBytes?: number; maxStateBytes?: number };
};
type Reply = {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
	outputs: InFile[];
	skippedOutputs: string[];
	state?: { globals?: string; imports: string[]; files: InFile[] };
	stateNote?: string;
	packages: string[];
};

const VENDOR = new URL("./vendor", import.meta.url).pathname;

const HELPERS = `
import base64, importlib, sys, types

def _seva_load_globals(data: str) -> None:
    """Restores what _seva_dump_globals saved: the values, then the modules under the names the code gave them."""
    import dill
    saved = dill.loads(base64.b64decode(data))
    main = vars(sys.modules["__main__"])
    for alias, module in saved["modules"].items():
        main[alias] = importlib.import_module(module)
    main.update(saved["values"])

def _seva_dump_globals(max_bytes: int):
    """The code's variables as a dill snapshot. Values that cannot be saved (a generator, an open file) are left out by name."""
    import dill
    values, modules, skipped = {}, {}, []
    for name, value in list(vars(sys.modules["__main__"]).items()):
        if name.startswith("_") or name in ("base64", "importlib", "sys", "types"):
            continue
        if isinstance(value, types.ModuleType):
            modules[name] = value.__name__
            continue
        try:
            dill.dumps(value)
            values[name] = value
        except Exception:
            skipped.append(name)
    data = dill.dumps({"values": values, "modules": modules})
    if len(data) > max_bytes:
        return None, sorted(values), skipped, []
    return base64.b64encode(data).decode(), sorted(values), skipped, sorted(set(modules.values()))
`;

async function main() {
	const request: Request = JSON.parse(await new Response(Deno.stdin.readable).text());
	const reply = await run(request);
	Deno.stdout.writeSync(new TextEncoder().encode(`${request.nonce}${JSON.stringify(reply)}\n`));
}

async function run(request: Request): Promise<Reply> {
	const limits = { maxOutputFiles: 10, maxOutputBytes: 10 * 1024 * 1024, maxStateBytes: 20 * 1024 * 1024, ...request.limits };
	const stdout: string[] = [];
	const stderr: string[] = [];
	const reply: Reply = { ok: false, stdout: "", stderr: "", outputs: [], skippedOutputs: [], packages: [] };
	// Pyodide logs package loading with console.log; only the reply goes to stdout.
	console.log = () => {};

	let pyodide: PyodideInterface;
	try {
		pyodide = await loadPyodide({
			stdout: (line) => stdout.push(line),
			stderr: (line) => stderr.push(line),
			jsglobals: {},
			env: { HOME: "/work", MPLBACKEND: "Agg" },
		});
		// Pure-Python packages from setup.sh, copied in: Python gets no path to the host's disk.
		copyIn(pyodide, VENDOR, "/vendor");
		pyodide.runPython(`import sys; sys.path.append("/vendor"); sys.setrecursionlimit(1000)`);

		// /work: the state's files, then fresh inputs and an empty outputs folder.
		for (const file of request.state?.files ?? []) writeFile(pyodide, file);
		pyodide.FS.mkdirTree("/work/inputs");
		pyodide.FS.mkdirTree("/work/outputs");
		for (const file of request.files ?? []) writeFile(pyodide, file);
		pyodide.FS.chdir("/work");
	} catch (error) {
		return { ...reply, error: `The sandbox could not start: ${message(error)}` };
	}

	const helpers = pyodide.globals;
	try {
		// The code's imports, dill, and the modules the earlier runs imported, which the state refers to.
		const earlier = (request.state?.imports ?? []).map((module) => `import ${module}`);
		const imports = [request.code, "import dill", ...earlier].join("\n");
		await pyodide.loadPackagesFromImports(imports, {
			messageCallback: (text) => {
				const loaded = text.match(/^Loaded (.+)$/);
				if (loaded) reply.packages.push(...loaded[1].split(", "));
			},
			errorCallback: (text) => stderr.push(text),
		});
		pyodide.runPython(HELPERS);
		if (request.state?.globals) helpers.get("_seva_load_globals")(request.state.globals);
		await pyodide.runPythonAsync(request.code);
		reply.ok = true;
	} catch (error) {
		reply.error = pythonError(error);
	}

	const outputs = collect(pyodide, "/work/outputs", limits.maxOutputFiles, limits.maxOutputBytes);
	reply.outputs = outputs.files;
	reply.skippedOutputs = outputs.skipped;

	// The state: what the next run in this thread starts with.
	try {
		const [globals, kept, skipped, imports] = helpers.get("_seva_dump_globals")(limits.maxStateBytes).toJs() as [string | undefined, string[], string[], string[]];
		const files = collect(pyodide, "/work", 200, limits.maxStateBytes, ["/work/inputs", "/work/outputs"]);
		reply.state = { globals: globals ?? undefined, imports, files: files.files };
		const notes = [];
		if (!globals && kept.length) notes.push(`The variables were too large to keep (over ${limits.maxStateBytes / 1024 / 1024} MB).`);
		if (skipped.length) notes.push(`Not kept for the next run: ${skipped.join(", ")}.`);
		if (files.skipped.length) notes.push(`Files not kept: ${files.skipped.join(", ")}.`);
		if (notes.length) reply.stateNote = notes.join(" ");
	} catch (error) {
		reply.stateNote = `Nothing was kept for the next run: ${message(error)}`;
	}

	reply.stdout = stdout.join("\n");
	reply.stderr = stderr.join("\n");
	return reply;
}

/** Copies a folder of the host into Pyodide's in-memory file system. */
function copyIn(pyodide: PyodideInterface, from: string, to: string) {
	pyodide.FS.mkdirTree(to);
	for (const entry of Deno.readDirSync(from)) {
		if (entry.isDirectory) copyIn(pyodide, `${from}/${entry.name}`, `${to}/${entry.name}`);
		else if (entry.isFile) pyodide.FS.writeFile(`${to}/${entry.name}`, Deno.readFileSync(`${from}/${entry.name}`));
	}
}

function writeFile(pyodide: PyodideInterface, file: InFile) {
	const path = file.path.startsWith("/work/") ? file.path : `/work/${file.path}`;
	pyodide.FS.mkdirTree(path.slice(0, path.lastIndexOf("/")));
	pyodide.FS.writeFile(path, Uint8Array.from(atob(file.base64), (char) => char.charCodeAt(0)));
}

/** The files under `root`, within a count and a total size; the rest by name in `skipped`. */
function collect(pyodide: PyodideInterface, root: string, maxFiles: number, maxBytes: number, exclude: string[] = []) {
	const files: InFile[] = [];
	const skipped: string[] = [];
	let total = 0;
	const walk = (dir: string) => {
		for (const name of pyodide.FS.readdir(dir).filter((entry: string) => entry !== "." && entry !== "..").sort()) {
			const path = `${dir}/${name}`;
			if (exclude.includes(path)) continue;
			const { mode, size } = pyodide.FS.stat(path);
			if (pyodide.FS.isDir(mode)) {
				walk(path);
				continue;
			}
			const relative = path.slice(root.length + 1);
			if (files.length >= maxFiles || total + size > maxBytes) {
				skipped.push(relative);
				continue;
			}
			files.push({ path: relative, base64: toBase64(pyodide.FS.readFile(path)) });
			total += size;
		}
	};
	walk(root);
	return { files, skipped };
}

function toBase64(bytes: Uint8Array) {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(binary);
}

/** A Python error is its traceback, without the frames of Pyodide's own code. */
function pythonError(error: unknown) {
	const text = message(error);
	const lines = text.split("\n");
	const start = lines.findIndex((line) => line.includes('File "<exec>"'));
	return start > 0 ? ["Traceback (most recent call last):", ...lines.slice(start)].join("\n") : text;
}

function message(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(`runner: ${message(error)}`);
		Deno.exit(1);
	});
}
