/**
 * Fills a scratch database with demo data for the README screenshots (scripts/demo/README.md).
 * Everything here is made up: the people, their chats, the café, the food bank. The web
 * pages cited are real public pages, with short excerpts in our own words.
 *
 *   DATABASE_URL=postgres://ponder:ponder@127.0.0.1:55432/ponder_demo \
 *   BETTER_AUTH_SECRET=... npx tsx scripts/demo/seed.ts --cookie /tmp/ponder-demo-cookie.json
 *
 * It refuses a database whose name does not contain "demo", and it deletes what an
 * earlier run wrote, so it can run again. Start the server once on the database first:
 * the server creates the tables. The cookie file signs Playwright in as the demo person.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/none").pathname.slice(1);
if (!database.includes("demo")) {
	console.error(`Refusing to seed "${database}": the database name must contain "demo". This script deletes data.`);
	process.exit(1);
}

const { sql } = await import("../../server/db.ts");
const { auth } = await import("../../server/auth.ts");

const here = path.dirname(fileURLToPath(import.meta.url));
const asset = (name: string) => readFileSync(path.join(here, "assets", name));
const cookieFile = process.argv[process.argv.indexOf("--cookie") + 1] ?? "";
const host = process.env.PONDER_HOSTS?.split(",")[0] ?? `127.0.0.1:${process.env.PORT ?? 3500}`;

const DEMO_EMAIL = "alex@example.com";
const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms);
const minutes = (n: number) => n * 60 * 1000;
const hours = (n: number) => n * 60 * 60 * 1000;

// --- People -----------------------------------------------------------------

const OTHERS = [
	["Jordan Ellis", "jordan@example.com"],
	["Sam Okafor", "sam@example.com"],
	["Lena Fischer", "lena@example.org"],
	["Diego Morales", "diego@example.org"],
	["Aiko Tanaka", "aiko@example.net"],
	["Noah Bennett", "noah@example.net"],
	["Fatima Rahman", "fatima@example.com"],
] as const;
const INVITES = ["maria@example.org", "kofi@example.net"];

// The browsers that people signed in from, for "Signed in on" on a person's admin page.
const DEVICES = {
	macChrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
	iPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1",
	android: "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36",
	windowsEdge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
	macFirefox: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.1; rv:144.0) Gecko/20100101 Firefox/144.0",
};

async function reset() {
	const emails = [DEMO_EMAIL, ...OTHERS.map(([, email]) => email)];
	const users = await sql<{ id: string }[]>`select id from users where email in ${sql(emails)}`;
	const ids = users.map((user) => user.id);
	if (ids.length) {
		for (const table of ["threads", "files", "memories", "memory_saves"]) await sql`delete from ${sql(table)} where owner in ${sql(ids)}`;
		await sql`delete from runs where "user" in ${sql(ids)}`;
		await sql`delete from mcp_connections where user_id in ${sql(ids)}`;
		await sql`delete from credit_requests where user_id in ${sql(ids)}`;
		await sql`delete from credit_grants where user_id in ${sql(ids)}`;
		await sql`delete from sessions where "userId" in ${sql(ids)}`;
		await sql`delete from accounts where "userId" in ${sql(ids)}`;
		await sql`delete from users where id in ${sql(ids)}`;
	}
	await sql`delete from allowed_emails where email in ${sql([...emails, ...INVITES])}`;
}

/** Signs the demo person in through Better Auth, as the sign-in page would, and returns the cookies. */
async function signIn() {
	await sql`insert into allowed_emails (email, note) values (${DEMO_EMAIL}, 'Demo') on conflict do nothing`;
	const headers = new Headers({ host, "x-forwarded-for": "127.0.0.1", "user-agent": DEVICES.macChrome });
	const otp = await auth.api.createVerificationOTP({ body: { email: DEMO_EMAIL, type: "sign-in" }, headers });
	const signed = await auth.api.signInEmailOTP({ body: { email: DEMO_EMAIL, otp }, headers, returnHeaders: true });
	const [user] = await sql<{ id: string }[]>`update users set name = 'Alex Rivera', role = 'admin' where email = ${DEMO_EMAIL} returning id`;
	const [hostname] = host.split(":");
	// Only the session token: the cached session cookie still holds the name and role from before the update above.
	const cookies = signed.headers
		.getSetCookie()
		.map((line) => {
			const [pair] = line.split(";");
			const at = pair.indexOf("=");
			return { name: pair.slice(0, at), value: pair.slice(at + 1), domain: hostname, path: "/", httpOnly: true, sameSite: "Lax" as const };
		})
		.filter((cookie) => cookie.name.endsWith("session_token"));
	return { userId: user.id, cookies };
}

async function addOthers() {
	const ids: string[] = [];
	for (const [index, [name, email]] of OTHERS.entries()) {
		const id = randomUUID();
		const joined = ago(DAY * (40 - index * 4));
		await sql`
			insert into users (id, name, email, "emailVerified", "createdAt", "updatedAt", role)
			values (${id}, ${name}, ${email}, true, ${joined}, ${joined}, ${index === 0 ? "admin" : "user"})`;
		ids.push(id);
		await addSessions(id, index);
		await addChatCount(id, 6 + index * 5);
	}
	await sql`insert into allowed_emails (email, note, daily_credits) values ('maria@example.org', 'Board member', 1500), ('kofi@example.net', 'Volunteer lead', null)`;
	return ids;
}

/** One or two signed-in devices for each person: a phone, and for some a computer too. */
async function addSessions(userId: string, index: number) {
	const phone = index % 2 ? DEVICES.android : DEVICES.iPhone;
	const computers = [DEVICES.macChrome, DEVICES.windowsEdge, DEVICES.macFirefox];
	const devices = index % 3 === 2 ? [phone] : [phone, computers[index % computers.length]];
	for (const [n, agent] of devices.entries()) {
		const used = ago(minutes(15 + index * 7) + hours(n * 20));
		await sql`
			insert into sessions (id, "expiresAt", token, "createdAt", "updatedAt", "userAgent", "userId")
			values (${randomUUID()}, ${new Date(now + DAY * 7)}, ${randomUUID()}, ${ago(DAY * 3)}, ${used}, ${agent}, ${userId})`;
	}
}

/** Empty chats, so the admin pages count some for each person. Admins never see what is in them. */
async function addChatCount(owner: string, count: number) {
	for (let n = 0; n < count; n += 1) {
		await sql`insert into threads (id, owner, title, updated_at) values (${randomUUID().slice(0, 8)}, ${owner}, ${`Chat ${n + 1}`}, ${ago(hours(n * 9 + 1))})`;
	}
}

// --- Files --------------------------------------------------------------------

async function addFile(owner: string, name: string, mediaType: string, data: Buffer) {
	const id = randomUUID().replaceAll("-", "").slice(0, 16);
	await sql`insert into files (id, owner, name, media_type, size, data, created_at) values (${id}, ${owner}, ${name}, ${mediaType}, ${data.length}, ${data}, ${ago(hours(3))})`;
	return { id, url: `/api/files/${id}`, size: data.length };
}

// --- Chats --------------------------------------------------------------------

type Part = Record<string, unknown>;
type Message = { id: string; role: "user" | "assistant"; parts: Part[]; metadata?: { model: string } };

const user = (id: string, ...parts: (string | Part)[]): Message => ({
	id,
	role: "user",
	parts: parts.map((part) => (typeof part === "string" ? { type: "text", text: part } : part)),
});
const reply = (id: string, model: string, ...parts: (string | Part)[]): Message => ({
	id,
	role: "assistant",
	metadata: { model },
	parts: [{ type: "step-start" }, ...parts.map((part) => (typeof part === "string" ? { type: "text", text: part, state: "done" } : part))],
});
const tool = (name: string, input: unknown, output: unknown): Part => ({
	type: `tool-${name}`,
	toolCallId: `call_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
	state: "output-available",
	input,
	output,
});
const reasoning = (text: string): Part => ({ type: "reasoning", text, state: "done" });

const SONNET = "anthropic/claude-sonnet-5.5";
const OPUS = "anthropic/claude-opus-5.5";
const TERRA = "openai/gpt-6.1-terra";
const FLASH = "deepseek/deepseek-v4.1-flash";
const GEMINI = "google/gemini-3.8-flash";

const IEA = "https://www.iea.org/reports/the-future-of-heat-pumps";
const DOE = "https://www.energy.gov/energysaver/air-source-heat-pumps";
const NEEP = "https://neep.org/heating-electrification/ccashp-specification-product-list";
const WIKI = "https://en.wikipedia.org/wiki/Air_source_heat_pump";

function heatPumps(): Message[] {
	return [
		user(
			"demo-heat-1",
			"Do heat pumps actually work in a real Minnesota winter? We're in Minneapolis and the installer says we'd still need a backup furnace. Is that a red flag?",
		),
		reply(
			"demo-heat-2",
			SONNET,
			reasoning("They want to know if cold-climate heat pumps hold up at Minneapolis winter lows, and whether a backup furnace is normal. Search for current performance data and the cold-climate spec."),
			tool(
				"web_search",
				{ query: "cold climate air source heat pump performance below zero" },
				{
					query: "cold climate air source heat pump performance below zero",
					results: [
						{
							n: 1,
							url: NEEP,
							title: "Cold Climate Air Source Heat Pump Specification and Product List | NEEP",
							text: "NEEP's list of air-source heat pumps that meet its cold-climate specification. Each model reports its heating capacity and efficiency at 47 °F, 17 °F and 5 °F, and many also at −15 °F.",
						},
						{
							n: 2,
							url: IEA,
							title: "The Future of Heat Pumps – Analysis – IEA",
							text: "Heat pumps are three to five times more energy efficient than gas boilers. Sales are growing in cold countries too: the highest shares of heat pumps in homes are in the Nordic countries.",
						},
						{
							n: 3,
							url: DOE,
							title: "Air-Source Heat Pumps | Department of Energy",
							text: "An air-source heat pump can reduce electricity use for heating by about 50% compared with electric resistance heating such as furnaces and baseboard heaters. Cold-climate models have improved in recent years.",
						},
						{
							n: 4,
							url: WIKI,
							title: "Air source heat pump – Wikipedia",
							text: "An air source heat pump moves heat from the outside air into a building. Its coefficient of performance falls as the outdoor temperature falls, so many cold-climate systems have a backup heat source.",
						},
					],
				},
			),
			tool("web_fetch", { url: NEEP }, { url: NEEP, title: "Cold Climate Air Source Heat Pump Specification and Product List | NEEP", text: "The list reports capacity and COP at 5 °F for every listed model." }),
			[
				"Not a red flag. Modern **cold-climate** heat pumps keep heating well below zero, and a backup for the coldest nights is normal in Minnesota.",
				"",
				"- **They still heat at 5 °F and below.** Models on NEEP's cold-climate list report their capacity and efficiency at 5 °F, and many at −15 °F too [NEEP](" + NEEP + ").",
				"- **They are much more efficient than resistance heat.** They move three to five units of heat for each unit of electricity on a mild day [IEA](" + IEA + "), and they use about half the electricity of baseboard heat over a season [Energy.gov](" + DOE + ").",
				"- **Efficiency falls as it gets colder.** Below about 0 °F a heat pump makes less heat while your house needs more, so most systems here hand over to a backup on the worst nights [Wikipedia](" + WIKI + ").",
				"",
				"**What to ask the installer**",
				"",
				"1. Is the unit on NEEP's cold-climate list, and what is its capacity at 5 °F?",
				"2. What is the balance point: the outdoor temperature where the backup takes over?",
				"3. Will the backup be your existing gas furnace (dual fuel) or electric strips?",
				"",
				"With a well-sized unit, the furnace should run only a few dozen hours a winter.",
			].join("\n"),
		),
	];
}

function lisbon(): Message[] {
	return [
		user("demo-lisbon-1", "Plan three days in Lisbon in March with two kids (6 and 9). Not too much walking in one go."),
		reply(
			"demo-lisbon-2",
			GEMINI,
			[
				"Here is a relaxed plan that keeps the hills to the mornings, when the kids have the most energy.",
				"",
				"**Day 1: Alfama and the castle**",
				"",
				"- Take tram 28 early, before 9 am: by mid-morning the queue at Martim Moniz can take an hour.",
				"- Walk up to Castelo de São Jorge, then down through Alfama's lanes for lunch.",
				"- Watch the sunset from Miradouro da Senhora do Monte.",
				"",
				"**Day 2: Belém by the river**",
				"",
				"- Jerónimos Monastery at opening time, then custard tarts at Pastéis de Belém next door.",
				"- Walk along the river to the Padrão dos Descobrimentos; the kids can find their country on the map in the pavement.",
				"",
				"**Day 3: Sintra**",
				"",
				"- Train from Rossio, about 40 minutes. Book a timed morning slot for Pena Palace.",
				"- Back in Lisbon for an early dinner in Príncipe Real.",
			].join("\n"),
		),
	];
}

function cafeSales(csv: { url: string; id: string }, chart: { url: string; size: number }): Message[] {
	const code = `import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv("/work/inputs/cafe-sales.csv")
order = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
by_day = df.groupby("weekday")[["pastries", "coffees", "revenue"]].mean().reindex(order)
print(by_day.round(0).astype(int))

weekend = df[df.weekday.isin(["Sat", "Sun"])].pastries.sum() / df.pastries.sum()
print(f"\\nWeekend share of pastries: {weekend:.1%}")

fig, ax = plt.subplots(figsize=(8, 4.2), dpi=150)
colors = ["#4f46e5" if day in ("Sat", "Sun") else "#c7d2fe" for day in order]
bars = ax.bar(order, by_day["pastries"], color=colors, width=0.62)
ax.bar_label(bars, fmt="%.0f", padding=3)
ax.set_title("Average pastries sold per day, Aug–Oct", loc="left")
fig.savefig("/work/outputs/pastries-by-weekday.png")`;
	const stdout = `         pastries  coffees  revenue
weekday
Mon            63      148      645
Tue            56      129      565
Wed            64      148      648
Thu            69      158      693
Fri            89      210      911
Sat           134      317     1374
Sun           117      275     1197

Weekend share of pastries: 43.4%`;
	return [
		user(
			"demo-cafe-1",
			{ type: "file", url: csv.url, filename: "cafe-sales.csv", mediaType: "text/csv" },
			"Which weekday sells the most pastries? Chart it so I can plan the bake.",
		),
		reply(
			"demo-cafe-2",
			TERRA,
			tool(
				"run_python",
				{ code, inputs: [{ name: "cafe-sales.csv", file_id: csv.id }] },
				{ ok: true, stdout, stderr: "", files: [{ url: chart.url, name: "pastries-by-weekday.png", size: chart.size, media_type: "image/png" }] },
			),
			[
				"**Saturday** sells the most: 134 pastries on an average day, more than twice a Tuesday (56). Weekends are two days in seven but **43%** of pastry sales.",
				"",
				"- Friday starts the climb (89), so a bigger Friday bake pays off.",
				"- Tuesday is the quietest day: try a smaller batch, about 10% less.",
				"- Coffee follows the same curve, so staff the bar to match.",
			].join("\n"),
		),
	];
}

/** Sample data made with Python: 100 students in a CSV, which opens in the side panel as a table. */
function students(csv: { url: string; size: number }): Message[] {
	const code = `import random
import pandas as pd

random.seed(12)
first = ["Aarav", "Abena", "Amara", "Anika", "Ben", "Carlos", "Chloe", "Daniel", "Dara", "Elif",
         "Ethan", "Fatima", "Felix", "Grace", "Hana", "Hugo", "Isaac", "Ines", "Jaya", "Jonas",
         "Kai", "Kemi", "Layla", "Leo", "Lucia", "Mateo", "Maya", "Mei", "Nadia", "Noah",
         "Olivia", "Omar", "Oscar", "Priya", "Rafael", "Rosa", "Ruby", "Sami", "Sofia", "Tariq",
         "Theo", "Uma", "Victor", "Yara", "Yusuf", "Zara", "Zoe", "Arjun", "Ella", "Mila"]
last = ["Adeyemi", "Alvarez", "Bauer", "Brooks", "Chen", "Costa", "Dubois", "Eriksen", "Evans", "Farah",
        "Fernandes", "Garcia", "Haddad", "Hughes", "Ito", "Jensen", "Johansson", "Kaur", "Kim", "Kowalski",
        "Lindqvist", "Lopez", "Mensah", "Moreau", "Murphy", "Nakamura", "Nguyen", "Novak", "Okafor", "Owusu",
        "Park", "Patel", "Petrov", "Quinn", "Reyes", "Rossi", "Sato", "Santos", "Schmidt", "Shah",
        "Silva", "Sousa", "Tanaka", "Torres", "Varga", "Walsh", "Weber", "Wong", "Yilmaz", "Zhang"]

def score(base):
    return max(35, min(100, round(random.gauss(base, 11))))

rows = []
for surname in last:
    for name in random.sample(first, 2):
        ability = random.gauss(72, 8)
        rows.append({"Student": f"{name} {surname}", "Class": random.choice(["7A", "7B", "8A", "8B"]),
                     "Maths": score(ability), "Science": score(ability - 2), "English": score(ability + 2)})

df = pd.DataFrame(rows).sort_values(["Class", "Student"])
df.to_csv("/work/outputs/students.csv", index=False)
print(f"{len(df)} students in {df.Class.nunique()} classes\\n")
print(df[["Maths", "Science", "English"]].agg(["mean", "min", "max"]).round(1))`;
	const stdout = `100 students in 4 classes

      Maths  Science  English
mean   70.0     67.4     72.4
min    39.0     36.0     48.0
max   100.0    100.0    100.0`;
	return [
		user(
			"demo-students-1",
			"Make sample data for 100 students: name, class, and marks in maths, science and English. I need it to test our report-card template.",
		),
		reply(
			"demo-students-2",
			SONNET,
			tool("run_python", { code }, { ok: true, stdout, stderr: "", files: [{ url: csv.url, name: "students.csv", size: csv.size, media_type: "text/csv" }] }),
			[
				"Here is **students.csv**: 100 made-up students in classes 7A to 8B, with a mark out of 100 for maths, science and English.",
				"",
				"- Averages are about 70 in maths, 67 in science and 72 in English.",
				"- A few students in each subject are under 50, so the template's \"needs support\" rows get tested too.",
				"- Marks go with each student's overall level, so a strong student is strong in most subjects, as in a real class.",
			].join("\n"),
		),
	];
}

const DECK = `<style>
section { font-family: "Inter", "Helvetica Neue", Arial, sans-serif; color: #1c2a22; background: #fbfaf5; padding: 80px 96px; box-sizing: border-box; }
h1 { font-size: 76px; line-height: 1.05; letter-spacing: -0.02em; color: #14532d; margin: 0 0 20px; }
h2 { font-size: 46px; letter-spacing: -0.01em; color: #14532d; margin: 0 0 40px; }
p, li { font-size: 28px; line-height: 1.45; color: #374151; }
.kicker { font-size: 20px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; color: #4d7c0f; margin: 0 0 28px; }
.title { display: flex; flex-direction: column; justify-content: center; background: linear-gradient(135deg, #ecfccb 0%, #fbfaf5 60%); }
.stats { display: flex; gap: 48px; margin-top: 24px; }
.stat { flex: 1; border-top: 4px solid #84cc16; padding-top: 20px; }
.stat b { display: block; font-size: 88px; line-height: 1; color: #14532d; letter-spacing: -0.03em; }
.stat span { font-size: 24px; color: #4b5563; }
</style>
<section class="title">
<p class="kicker">Riverside Food Bank · Board meeting</p>
<h1>Q3 volunteer report</h1>
<p>July to September 2026</p>
</section>
<section>
<h2>Q3 at a glance</h2>
<div class="stats">
<div class="stat"><b>412</b><span>active volunteers</span></div>
<div class="stat"><b>6,180</b><span>hours given</span></div>
<div class="stat"><b>38,500</b><span>meals packed</span></div>
</div>
<p style="margin-top: 56px;">Up 18% on Q2, with the new Saturday shift doing most of the growth.</p>
</section>
<section>
<h2>Hours by month</h2>
<svg viewBox="0 0 1080 420" width="1080" height="420" font-family="Inter, Arial, sans-serif">
<line x1="0" y1="380" x2="1080" y2="380" stroke="#d6d3d1" stroke-width="2"/>
<rect x="90" y="140" width="200" height="240" rx="8" fill="#bef264"/>
<rect x="440" y="110" width="200" height="270" rx="8" fill="#84cc16"/>
<rect x="790" y="74" width="200" height="306" rx="8" fill="#4d7c0f"/>
<text x="190" y="122" text-anchor="middle" font-size="30" fill="#1c2a22">1,820</text>
<text x="540" y="92" text-anchor="middle" font-size="30" fill="#1c2a22">2,040</text>
<text x="890" y="56" text-anchor="middle" font-size="30" fill="#1c2a22">2,320</text>
<text x="190" y="414" text-anchor="middle" font-size="26" fill="#4b5563">July</text>
<text x="540" y="414" text-anchor="middle" font-size="26" fill="#4b5563">August</text>
<text x="890" y="414" text-anchor="middle" font-size="26" fill="#4b5563">September</text>
</svg>
</section>
<section>
<h2>What worked</h2>
<ul>
<li>The Saturday family shift: 96 new volunteers, most of them parents with teens.</li>
<li>Text reminders the day before cut no-shows from 14% to 6%.</li>
<li>Two corporate team days packed 4,200 meals.</li>
</ul>
</section>
<section>
<h2>Asks for Q4</h2>
<ul>
<li>Approve a second van driver for the holiday rush.</li>
<li>Fund a shared calendar tool: about $40 a month.</li>
<li>Thank-you event for volunteers in December.</li>
</ul>
</section>`;

function deck(): Message[] {
	return [
		user(
			"demo-deck-1",
			"Make a five-slide deck for Thursday's board meeting. Q3: 412 volunteers, 6,180 hours (July 1,820, August 2,040, September 2,320), 38,500 meals. Saturday shift added 96 people, reminders cut no-shows from 14% to 6%. Asks: second van driver, a calendar tool, a December thank-you event.",
		),
		reply(
			"demo-deck-2",
			OPUS,
			{
				...tool(
					"write_artifact",
					{ id: "q3-volunteer-report", kind: "slides", title: "Q3 volunteer report", content: DECK },
					{ ok: true, id: "q3-volunteer-report", kind: "slides", title: "Q3 volunteer report", shown: "The person sees it in the side panel." },
				),
			},
			"Here is the deck: a title slide, the three headline numbers, hours by month as a bar chart, what worked, and your three asks for Q4. Present opens it full screen for Thursday.",
		),
	];
}

function linearBug(): Message[] {
	return [
		user("demo-linear-1", "File a bug in Linear for the volunteer sign-up form: the date picker skips Sundays. Website team, high priority."),
		reply(
			"demo-linear-2",
			SONNET,
			tool("linear__list_teams", {}, { content: [{ type: "text", text: '[{"id":"WEB","name":"Website"},{"id":"OPS","name":"Operations"}]' }] }),
			{
				type: "tool-linear__create_issue",
				toolCallId: "call_demo_create_issue",
				state: "approval-requested",
				input: {
					team: "WEB",
					title: "Sign-up form: date picker skips Sundays",
					priority: 2,
					description: "On /volunteer, the shift date picker jumps from Saturday to Monday, so nobody can sign up for the Sunday shift.",
				},
				approval: { id: "demo-approval-1" },
			},
		),
	];
}

/** Short chats to fill the list. */
const OTHER_CHATS: { id: string; title: string; ago: number; model: string; ask: string; answer: string }[] = [
	{ id: "demo-email", title: "Rewrite the volunteer welcome email", ago: hours(26), model: FLASH, ask: "Make this welcome email warmer and half as long.", answer: "Here is a shorter version that leads with the thank-you and keeps the one link they need." },
	{ id: "demo-sourdough", title: "Sourdough starter feeding schedule", ago: DAY * 2 + hours(3), model: FLASH, ask: "How often should I feed a starter that lives in the fridge?", answer: "Once a week is enough. Take it out the night before you bake, feed it 1:1:1, and use it when it has doubled." },
	{ id: "demo-postgres", title: "Postgres or SQLite for a side project", ago: DAY * 3, model: TERRA, ask: "Postgres or SQLite for a small app with one server?", answer: "SQLite, unless you need several servers to write at once. It is one file, it backs up with a copy, and it is fast for this size." },
	{ id: "demo-meals", title: "Vegetarian meal plan for the week", ago: DAY * 4, model: GEMINI, ask: "A vegetarian dinner plan for 5 nights, 30 minutes each, kid friendly.", answer: "Monday: black bean tacos. Tuesday: pasta with roasted tomatoes. Wednesday: vegetable fried rice. Thursday: halloumi wraps. Friday: homemade pizza." },
	{ id: "demo-index-funds", title: "Explain index funds simply", ago: DAY * 6, model: SONNET, ask: "Explain index funds like I'm new to investing.", answer: "An index fund buys a little of every company in a list, such as the 500 largest in the US, so you own the market instead of guessing which company wins." },
	{ id: "demo-board-notes", title: "Board meeting notes, September", ago: DAY * 12, model: OPUS, ask: "Turn these notes into minutes with actions and owners.", answer: "Here are the minutes, with four actions and an owner for each." },
	{ id: "demo-grant", title: "Grant application outline", ago: DAY * 18, model: OPUS, ask: "Outline a grant application for a new refrigerated van.", answer: "A six-part outline: need, plan, budget, impact, partners and how you will report back." },
];

async function addThreads(owner: string) {
	const csvBytes = asset("cafe-sales.csv");
	const csv = await addFile(owner, "cafe-sales.csv", "text/csv", csvBytes);
	await sql`update files set text = ${csvBytes.toString("utf8")} where id = ${csv.id}`;
	const chart = await addFile(owner, "pastries-by-weekday.png", "image/png", asset("pastries-by-weekday.png"));
	const studentsCsv = await addFile(owner, "students.csv", "text/csv", asset("students.csv"));

	const chats: { id: string; title: string; updated: Date; messages: Message[] }[] = [
		{ id: "demo-heat-pumps", title: "Heat pumps in a Minnesota winter", updated: ago(minutes(4)), messages: heatPumps() },
		{ id: "demo-cafe", title: "Café pastry sales by weekday", updated: ago(minutes(48)), messages: cafeSales(csv, chart) },
		{ id: "demo-students", title: "Sample data: 100 students", updated: ago(hours(1)), messages: students(studentsCsv) },
		{ id: "demo-deck", title: "Q3 volunteer report deck", updated: ago(hours(2)), messages: deck() },
		{ id: "demo-linear", title: "Linear bug: date picker skips Sundays", updated: ago(hours(3)), messages: linearBug() },
		{ id: "demo-lisbon", title: "Lisbon in three days with kids", updated: ago(hours(22)), messages: lisbon() },
		...OTHER_CHATS.map((chat) => ({
			id: chat.id,
			title: chat.title,
			updated: ago(chat.ago),
			messages: [user(`${chat.id}-1`, chat.ask), reply(`${chat.id}-2`, chat.model, chat.answer)],
		})),
	];
	for (const chat of chats) {
		await sql`delete from threads where id = ${chat.id}`;
		await sql`
			insert into threads (id, owner, title, messages, updated_at)
			values (${chat.id}, ${owner}, ${chat.title}, ${sql.json(chat.messages as never)}, ${chat.updated})`;
	}
}

// --- Memory -------------------------------------------------------------------

async function addMemories(owner: string) {
	const memories = [
		{ kind: "fact", text: "Lives in Minneapolis and is weighing a heat pump for their home.", thread: "demo-heat-pumps", message: "demo-heat-2", quote: "We're in Minneapolis", at: minutes(3) },
		{ kind: "fact", text: "Co-owns a small café and tracks its sales in CSV exports.", thread: "demo-cafe", message: "demo-cafe-2", at: minutes(47) },
		{ kind: "fact", text: "Coordinates volunteers at Riverside Food Bank and reports to its board each quarter.", thread: "demo-deck", message: "demo-deck-2", at: hours(2) },
		{ kind: "fact", text: "Travelling to Lisbon in March with two kids, aged 6 and 9.", thread: "demo-lisbon", message: "demo-lisbon-2", at: hours(22) },
		{ kind: "preference", text: "Prefers short answers that lead with the recommendation.", thread: "demo-email", message: "demo-email-2", at: hours(26) },
		{ kind: "preference", text: "Cooks vegetarian dinners that take about 30 minutes.", thread: "demo-meals", message: "demo-meals-2", at: DAY * 4 },
		{ kind: "fact", text: "Is new to investing and wants plain-language explanations.", thread: "demo-index-funds", message: "demo-index-funds-2", at: DAY * 6 },
	];
	for (const memory of memories) {
		const id = randomUUID();
		const at = ago(memory.at);
		await sql`
			insert into memories (id, owner, kind, text, reason, source_thread, source_message, created_at, updated_at)
			values (${id}, ${owner}, ${memory.kind}, ${memory.text}, 'Said in the chat', ${memory.thread}, ${memory.message}, ${at}, ${at})`;
		const operation = { op: "add", kind: memory.kind, text: memory.text, quote: memory.quote ?? memory.text, reason: "Said in the chat", status: "applied", memoryId: id };
		await sql`
			insert into memory_saves (owner, thread_id, message_id, summary, operations, model, ok, ms, created_at)
			values (${owner}, ${memory.thread}, ${memory.message}, 'Added 1 memory', ${sql.json([operation] as never)}, ${FLASH}, true, 900, ${at})`;
	}
}

// --- Connectors ---------------------------------------------------------------

async function addConnector(owner: string) {
	const schema = { type: "object", properties: {} };
	const tools = [
		{ name: "list_issues", title: "List issues", description: "List issues in a team, with filters for state, assignee and label.", inputSchema: schema, readOnly: true, destructive: false },
		{ name: "get_issue", title: "Get issue", description: "Read one issue with its comments.", inputSchema: schema, readOnly: true, destructive: false },
		{ name: "list_teams", title: "List teams", description: "List the teams in the workspace.", inputSchema: schema, readOnly: true, destructive: false },
		{ name: "create_issue", title: "Create issue", description: "Create an issue in a team.", inputSchema: schema, readOnly: false, destructive: false },
		{ name: "update_issue", title: "Update issue", description: "Change an issue's title, state, priority or assignee.", inputSchema: schema, readOnly: false, destructive: false },
		{ name: "create_comment", title: "Create comment", description: "Add a comment to an issue.", inputSchema: schema, readOnly: false, destructive: false },
	];
	const rules = { list_issues: "allow", get_issue: "allow", list_teams: "allow", create_issue: "ask", update_issue: "ask", create_comment: "off" };
	await sql`
		insert into mcp_connections (id, user_id, name, slug, url, transport, auth, status, enabled, header_names, server_info, tools, tools_checked_at, tool_rules, last_used_at, created_at, updated_at)
		values (${randomUUID()}, ${owner}, 'Linear', 'linear', 'https://mcp.linear.app/mcp', 'http', 'oauth', 'connected', true, ${sql.array([])},
			${sql.json({ name: "linear", title: "Linear", version: "1.4.0" })}, ${sql.json(tools as never)}, now(), ${sql.json(rules)}, ${ago(hours(3))}, ${ago(DAY * 9)}, now())`;
	await sql`
		insert into mcp_connections (id, user_id, name, slug, url, transport, auth, status, enabled, header_names, server_info, tools, tools_checked_at, tool_rules, created_at, updated_at)
		values (${randomUUID()}, ${owner}, 'Food bank docs', 'food-bank-docs', 'https://docs.riverside-foodbank.example/mcp', 'http', 'headers', 'connected', true, ${sql.array(["Authorization"])},
			${sql.json({ name: "docs", title: "Food bank docs" })},
			${sql.json([{ name: "search_docs", title: "Search docs", description: "Search the handbook and shift guides.", inputSchema: schema, readOnly: true, destructive: false }] as never)},
			now(), ${sql.json({ search_docs: "allow" })}, ${ago(DAY * 14)}, now())`;
}

// --- Usage, for credits and /admin ---------------------------------------------

/** A small seeded random, so every run of the seed draws the same charts. */
function random(seed: number) {
	return () => {
		seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31;
		return seed / 2 ** 31;
	};
}

async function addUsage(demo: string, others: string[]) {
	const next = random(42);
	const models = [FLASH, FLASH, FLASH, SONNET, SONNET, TERRA, GEMINI, OPUS, "anthropic/claude-haiku-5.5"];
	const rows: Record<string, unknown>[] = [];
	const people = [demo, ...others];
	for (let day = 29; day >= 0; day -= 1) {
		for (const [index, person] of people.entries()) {
			// People join over the month, and fewer come at the weekend.
			if (index > 0 && day > 32 - index * 4) continue;
			const weekday = new Date(now - day * DAY).getUTCDay();
			if (next() < (weekday === 0 || weekday === 6 ? 0.55 : 0.2)) continue;
			const replies = 2 + Math.floor(next() * (index === 0 ? 9 : 6) + (29 - day) / 8);
			for (let n = 0; n < replies; n += 1) {
				const model = models[Math.floor(next() * models.length)]!;
				const cost = model === OPUS ? 0.03 + next() * 0.05 : model === FLASH ? 0.0008 + next() * 0.002 : 0.004 + next() * 0.012;
				const at = new Date(now - day * DAY - Math.floor(next() * (day === 0 ? hours(5) : hours(12))));
				rows.push({
					id: randomUUID(),
					parent_id: null,
					thread_id: `usage-${person.slice(0, 6)}-${day}`,
					user: person,
					function_id: "chat",
					model,
					steps: 1,
					input_tokens: 2_000 + Math.floor(next() * 9_000),
					output_tokens: 200 + Math.floor(next() * 1_500),
					cached_tokens: 0,
					cost_usd: cost.toFixed(6),
					duration_ms: 1_500 + Math.floor(next() * 9_000),
					tool_calls: sql.json([]),
					finish_reason: "stop",
					created_at: at,
				});
			}
		}
	}
	for (let start = 0; start < rows.length; start += 500) await sql`insert into runs ${sql(rows.slice(start, start + 500) as never)}`;
	await sql`insert into credit_requests (user_id, created_at, status) values (${others[3]!}, ${ago(minutes(35))}, 'pending')`;
	await sql`insert into credit_limits (user_id, daily_credits) values (${others[1]!}, 2500) on conflict (user_id) do update set daily_credits = 2500`;
}

// --- Run ------------------------------------------------------------------------

await reset();
const { userId, cookies } = await signIn();
const others = await addOthers();
await addThreads(userId);
await addMemories(userId);
await addConnector(userId);
await addUsage(userId, others);
if (cookieFile) writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
console.log(`Seeded ${DEMO_EMAIL} (${userId}) and ${others.length} other people.${cookieFile ? ` Cookies: ${cookieFile}` : ""}`);
process.exit(0);
