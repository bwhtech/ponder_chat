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
];
