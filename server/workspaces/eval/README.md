# Workspace test questions

`questions.json` has 31 questions on two real procedure manuals: a nephrology manual (398 pages) and an obstetrics manual (180 pages). Each question names its document, the page or pages that answer it, a short `answer` text that a passage of that page must hold, and its `source`:

| Source | Count | Where the answer is |
| --- | --- | --- |
| `text` | 10 | In the PDF's text layer. |
| `table` | 7 | In a table of the text layer, which LiteParse writes as a Markdown table. |
| `picture` | 14 | Only in a picture: a dose table, a chart or a flowchart. Only the model's text of the page has it. |

The manuals are not in the repository. Put `nephrology.pdf` and `obgyn.pdf` in a folder and set `WORKSPACE_EVAL_DIR` to it.

## Run

```sh
WORKSPACE_EVAL_DIR=~/eval npx tsx server/workspaces/eval/run.ts
```

`run.ts` reads each manual with the PDF reader (`documents/read-pdf.ts`) and splits it with the chunker (`documents/chunk.ts`). For each question, it prints whether a passage covers the answer's page and whether that passage holds the answer. It also prints the passage sizes.

- `--live` reads the picture pages with the real model (about $0.06 for both manuals). It needs the app's environment (`set -a; . ~/.config/ponder-chat/.env; set +a`). It saves the model's text in `WORKSPACE_EVAL_DIR/model-pages.json`.
- Without `--live`, the picture pages come from `model-pages.json`. Without that file, a page with no text layer fails its manual, as it fails a real upload.
- `--recorded <file>` reads the model's text from another file.
- `--passages <file>` writes every passage to a JSON file.

## Next

When search exists, the script will also index the passages, search with each question, and score the top-8 hit rate: the share of questions with a passage of the right page, holding the answer, in the 8 best results. Run it before and after each change to the chunker, search or the PDF reader, and put the numbers in the pull request.
