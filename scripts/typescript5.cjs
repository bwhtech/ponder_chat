// The project's `tsc` is TypeScript 7, which no longer ships the TypeScript JS API.
// vue-tsc and typescript-eslint need that API. Requiring this file points `typescript`
// at the 5.x copy frappe-ui depends on, for the rest of the process.
const Module = require("node:module");
const path = require("node:path");

const fromFrappeUI = Module.createRequire(path.join(__dirname, "../node_modules/frappe-ui/package.json"));
const ts5Root = path.dirname(fromFrappeUI.resolve("typescript/package.json"));
const resolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
	if (request === "typescript" || request.startsWith("typescript/")) {
		request = ts5Root + request.slice("typescript".length);
	}
	return resolve.call(this, request, ...rest);
};
