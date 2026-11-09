#!/usr/bin/env bash
# Prepares the Python sandbox once, and again after a change to the package lists.
# Runs never reach the network: everything they can import is fetched here.
set -euo pipefail
cd "$(dirname "$0")"

# 1. Pyodide itself, pinned in package.json.
npm ci --no-audit --no-fund

# 2. Pyodide's own packages (built for WebAssembly), into its package cache in node_modules/pyodide.
deno run --no-prompt --allow-read=. --allow-write=node_modules/pyodide --allow-net=cdn.jsdelivr.net prefetch.ts

# 3. Pure-Python packages that Pyodide does not ship, unpacked into vendor/ (read-only at run time).
rm -rf vendor
uv pip install --quiet --target vendor --no-deps --python-version 3.14 --only-binary=:all: \
	openpyxl==3.1.5 et-xmlfile==2.0.0 seaborn==0.13.2 dill==0.4.0 tabulate==0.9.0 python-docx==1.2.0
echo "Python sandbox ready."
