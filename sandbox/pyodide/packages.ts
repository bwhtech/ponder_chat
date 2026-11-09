/**
 * The Pyodide packages that runs can import, fetched once by setup.sh (prefetch.ts).
 * Their dependencies come with them. A run can only load what is cached: it has no network.
 * Pure-Python packages that Pyodide does not ship are in setup.sh, step 3.
 */
export const PACKAGES = [
	"numpy",
	"pandas",
	"matplotlib",
	"scipy",
	"scikit-learn",
	"statsmodels",
	"sympy",
	"networkx",
	"pillow",
	"python-dateutil",
	"pytz",
	"xlrd",
	"beautifulsoup4",
	"lxml",
	"pyyaml",
	"regex",
	"typing-extensions",
];

/**
 * Pyodide packages that a vendored package imports. loadPackagesFromImports sees only the
 * code's own imports, so `import docx` alone would not load lxml.
 */
export const VENDOR_NEEDS: Record<string, string[]> = {
	docx: ["lxml", "typing_extensions"],
};

/** Import lines for the Pyodide packages that the code's vendored imports need. */
export function vendorImports(code: string) {
	return Object.entries(VENDOR_NEEDS)
		.filter(([module]) => new RegExp(`^\\s*(import|from)\\s+${module}\\b`, "m").test(code))
		.flatMap(([, needs]) => needs.map((name) => `import ${name}`));
}
