// Downloads the sandbox's packages into Pyodide's package cache. Run by setup.sh.
import { loadPyodide } from "pyodide";
import { PACKAGES } from "./packages.ts";

const pyodide = await loadPyodide();
await pyodide.loadPackage(PACKAGES, { messageCallback: (message: string) => console.log(message) });
