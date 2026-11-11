# Demo data and README images

These scripts fill a scratch database with made-up data and take the images in the main README (`docs/images/`). Use them to try Ponder with full chats, or to make the images again after a UI change.

| File | What it does |
| --- | --- |
| `seed.ts` | Writes the demo data and signs in the demo person. |
| `shots.mjs` | The list of images: which chat to open, what to click, and where to crop. |
| `assets/cafe-sales.csv` | The file that the Python chat reads. |
| `assets/pastries-by-weekday.png` | The chart that the Python chat shows. `assets/make_chart.py` draws it. |
| `assets/students.csv` | The sample data for 100 made-up students that the sheet chat shows as a table. `assets/make_students.py` writes it. |

## What the seed writes

Everything is made up. The web pages that the search chat cites are real public pages, with short excerpts in our own words.

- Alex Rivera (`alex@example.com`), an admin, with 13 chats. Eight of them show a feature: web search with citations, a quote to cite, a slide deck, a Python chart, a CSV that opens as a table, a connector that waits for approval, a skill that Ponder picked, and a skill that Alex chose.
- Seven memories, each with a note under the reply it came from.
- Four skills that admins wrote, next to the two that come with Ponder. Two are automatic, and two run only when someone asks for them.
- Two connectors: Linear (OAuth) and a docs server (API key). Neither one is called: their tool lists are written to the database.
- Seven more people, 30 days of usage, a request for more credits and two open invites, for the admin pages. Each person also has some empty chats (admins see only how many) and one or two devices they signed in on.

The seed refuses a database whose name does not contain `demo`, because it deletes data. It deletes what an earlier run wrote, so it can run again.

## Make the images again

You need Docker and Node. The images use the `clean-ui-shot` skill's scripts (`~/.claude/skills/clean-ui-shot/scripts/`), with `playwright` and `sharp`. The skill tells how to install them.

1. Start a scratch Postgres with pgvector:

   ```bash
   docker run -d --name ponder-demo-pg -p 127.0.0.1:55432:5432 \
     -e POSTGRES_USER=ponder -e POSTGRES_PASSWORD=ponder -e POSTGRES_DB=ponder_demo \
     pgvector/pgvector:pg18
   ```

2. Write the demo environment to a file, such as `/tmp/ponder-demo.env`. The key is not a real key: no reply runs while the images are taken. The queue image needs a reply on its way, so `shots.mjs` answers that message itself and keeps the reply open.

   ```bash
   DATABASE_URL=postgres://ponder:ponder@127.0.0.1:55432/ponder_demo
   WORKFLOW_POSTGRES_URL=postgres://ponder:ponder@127.0.0.1:55432/ponder_demo
   WORKFLOW_TARGET_WORLD=@workflow/world-postgres
   WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1
   BETTER_AUTH_SECRET=demo-secret-for-screenshots-only-0123456789abcdef
   OPENROUTER_API_KEY=sk-or-demo-not-a-real-key
   PORT=3590
   HOST=127.0.0.1
   ```

3. Build Ponder, create the workflow tables, and start the server. The server creates the other tables when it starts.

   ```bash
   set -a; . /tmp/ponder-demo.env; set +a
   npm run build
   npx --no-install bootstrap
   node .output/server/index.mjs
   ```

4. In a second shell, with the same environment, write the demo data:

   ```bash
   set -a; . /tmp/ponder-demo.env; set +a
   npx tsx scripts/demo/seed.ts --cookie /tmp/ponder-demo-cookies.json
   ```

   The cookie file signs the browser in as Alex. Open http://127.0.0.1:3590 and sign in as `alex@example.com` to look around. The code is in the server log.

5. Take the images:

   ```bash
   DEMO_COOKIES=/tmp/ponder-demo-cookies.json node ~/.claude/skills/clean-ui-shot/scripts/shoot.mjs \
     scripts/demo/shots.mjs --url http://127.0.0.1:3590 --out docs/images --style glass --format webp
   ```

   Add `--only cite,slides` to take some of them again.

6. Stop the server, and remove the database:

   ```bash
   kill $(lsof -tiTCP:3590 -sTCP:LISTEN)
   docker rm -f ponder-demo-pg
   ```

## How the images are taken

Each image is a 1280×720 window, taken at 3× and shrunk onto a glass stage. A crop keeps at least one edge of the window and runs off the stage on the other sides, so it reads as a detail of the app. `shots.mjs` measures each crop from the page, so a crop follows the layout and ends in white space.

The seed sets times relative to now, so the chat list and "minutes ago" stay current.
