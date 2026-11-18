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

// postgres.js, which the e2e tests use too: the server itself is on Effect's client.
const { default: postgres } = await import("postgres");
const sql = postgres(process.env.DATABASE_URL!, { onnotice: () => {} });
const Auth = await import("../../server/auth/Auth.ts");
const { runPromise } = await import("../../server/runtime/runtime.ts");
/** One of Better Auth's endpoints, on the app's runtime (server/auth/Auth.ts). */
const callAuth = <A>(endpoint: (api: import("../../server/auth/Auth.ts").AuthApi) => Promise<A>) => runPromise(Auth.Auth.use((auth) => auth.call(endpoint)));

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
		// Their members, pins, documents and logs go with them.
		await sql`delete from workspaces where owner_id in ${sql(ids)}`;
		await sql`delete from runs where "user" in ${sql(ids)}`;
		await sql`delete from mcp_connections where user_id in ${sql(ids)}`;
		await sql`delete from credit_requests where user_id in ${sql(ids)}`;
		await sql`delete from credit_grants where user_id in ${sql(ids)}`;
		await sql`delete from sessions where "userId" in ${sql(ids)}`;
		await sql`delete from accounts where "userId" in ${sql(ids)}`;
		await sql`delete from users where id in ${sql(ids)}`;
	}
	await sql`delete from allowed_emails where email in ${sql([...emails, ...INVITES])}`;
	await sql`delete from skills where name in ${sql(SKILLS.map((skill) => skill.name))}`;
}

/** Signs the demo person in through Better Auth, as the sign-in page would, and returns the cookies. */
async function signIn() {
	await sql`insert into allowed_emails (email, note) values (${DEMO_EMAIL}, 'Demo') on conflict do nothing`;
	const headers = new Headers({ host, "x-forwarded-for": "127.0.0.1", "user-agent": DEVICES.macChrome });
	const otp = await callAuth((api) => api.createVerificationOTP({ body: { email: DEMO_EMAIL, type: "sign-in" }, headers }));
	const signed = await callAuth((api) => api.signInEmailOTP({ body: { email: DEMO_EMAIL, otp }, headers, returnHeaders: true }));
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

/** Short chats to fill the list. `skill` is one that the person chose with $name. */
const OTHER_CHATS: { id: string; title: string; ago: number; model: string; ask: string; answer: string; skill?: string }[] = [
	{ id: "demo-email", title: "Rewrite the volunteer welcome email", ago: hours(26), model: FLASH, ask: "Make this welcome email warmer and half as long.", answer: "Here is a shorter version that leads with the thank-you and keeps the one link they need." },
	{ id: "demo-sourdough", title: "Sourdough starter feeding schedule", ago: DAY * 2 + hours(3), model: FLASH, ask: "How often should I feed a starter that lives in the fridge?", answer: "Once a week is enough. Take it out the night before you bake, feed it 1:1:1, and use it when it has doubled." },
	{ id: "demo-postgres", title: "Postgres or SQLite for a side project", ago: DAY * 3, model: TERRA, ask: "Postgres or SQLite for a small app with one server?", answer: "SQLite, unless you need several servers to write at once. It is one file, it backs up with a copy, and it is fast for this size." },
	{ id: "demo-meals", title: "Vegetarian meal plan for the week", ago: DAY * 4, model: GEMINI, ask: "A vegetarian dinner plan for 5 nights, 30 minutes each, kid friendly.", answer: "Monday: black bean tacos. Tuesday: pasta with roasted tomatoes. Wednesday: vegetable fried rice. Thursday: halloumi wraps. Friday: homemade pizza." },
	{ id: "demo-index-funds", title: "Explain index funds simply", ago: DAY * 6, model: SONNET, ask: "Explain index funds like I'm new to investing.", answer: "An index fund buys a little of every company in a list, such as the 500 largest in the US, so you own the market instead of guessing which company wins." },
	{ id: "demo-board-notes", title: "Board meeting notes, September", ago: DAY * 12, model: OPUS, skill: "meeting-minutes", ask: "Here are my notes from Tuesday. Same format as last month, please.", answer: "Here are the minutes, with four actions and an owner for each." },
];

/** Ponder picks the grant-writing skill on its own, and follows it. */
function grant(): Message[] {
	return [
		user("demo-grant-1", "Outline a grant application to the Riverside Community Fund for a refrigerated van. The van costs $62,000 and we have raised $48,000."),
		reply(
			"demo-grant-2",
			OPUS,
			tool("use_skill", { name: "grant-writing" }, GRANT_WRITING),
			`Here is an outline in the order that the Riverside Community Fund asks for. Each part says what to write and which numbers to bring.

### 1. The need

Each week we turn away fresh food that we cannot keep cold: about 1,200 lb in September. Say who misses out: 340 households a week, and a third of them have children.

### 2. The plan

One refrigerated van for the Tuesday and Friday routes to our four partner pantries. Say who drives it, and where it parks at night.

### 3. The budget

| Item | Cost |
| --- | --- |
| Refrigerated van, used, 2023 | $54,500 |
| Insurance for the first year | $3,800 |
| Signs on the van | $2,500 |
| Driver training and food safety | $1,200 |
| **Total** | **$62,000** |
| Raised already | $48,000 |
| **Asked of the fund** | **$14,000** |

### 4. The impact

In 12 months: 60,000 lb more fresh food delivered, and 4 pantries that can take milk and meat for the first time. [check] the pounds with the warehouse log.

### 5. Partners

Name the four pantries, and what each one does: storage, volunteers, or the families it serves.

### 6. Reporting

A short report at 6 and 12 months: pounds delivered, households served, and the van's costs.`,
		),
	];
}

// --- Skills --------------------------------------------------------------------

const GRANT_WRITING = `# Grant writing

Write for a reviewer who reads forty applications in a week.

## Before you start

- Ask for the funder's name and its questions, if the person did not give them. Use the funder's headings, in its order.
- Ask for the amount, the total cost, and what is raised already.

## Each section

1. **Need.** One number that shows the problem, and who it affects.
2. **Plan.** What we will do, where, how often and who does it.
3. **Budget.** A table. Every line has a cost. The total matches the ask.
4. **Impact.** What changes in 12 months, as numbers that we can count.
5. **Partners.** Name them, and what each one does.
6. **Reporting.** What we will report, and when.

## Style

- Plain words and short sentences. Write "we", not "the organization".
- No claim that we cannot prove. Mark a guess with [check].
- Keep each section under 200 words, unless the funder allows more.
`;

/** Skills an admin wrote, next to the two standard skills that the server adds when it starts. */
const SKILLS = [
	{ name: "grant-writing", automatic: true, ago: DAY * 9, by: 0, description: "Draft a grant application in the funder's own headings: need, plan, budget, impact, partners and reporting.", body: GRANT_WRITING },
	{
		name: "meeting-minutes",
		automatic: false,
		ago: DAY * 15,
		by: 1,
		description: "Turn meeting notes into minutes: decisions, actions with an owner and a date, and open questions.",
		body: "# Meeting minutes\n\n1. Start with the date, who came and who sent apologies.\n2. List each decision in one sentence.\n3. Make a table of actions: the action, the owner and the date.\n4. End with the open questions for the next meeting.\n",
	},
	{
		name: "volunteer-newsletter",
		automatic: true,
		ago: DAY * 3,
		by: 2,
		description: "Write the monthly volunteer newsletter in our warm, plain voice, in under 300 words.",
		body: "# Volunteer newsletter\n\n- Open with one number from the month and thank the people behind it.\n- Then: dates for next month, one volunteer story, and one ask.\n- Under 300 words. No exclamation marks.\n",
	},
	{
		name: "donor-thank-you",
		automatic: false,
		ago: DAY * 21,
		by: 0,
		description: "A thank-you letter to a donor that names the gift and what it paid for.",
		body: "# Donor thank-you\n\n- Name the gift and the date in the first line.\n- Say what it paid for, as one thing that the donor can picture.\n- One page or less. Sign it from the director.\n",
	},
];

async function addSkills(admins: string[]) {
	const Skills = await import("../../server/skills.ts");
	for (const skill of SKILLS) {
		const input = { name: skill.name, description: skill.description, automatic: skill.automatic, body: skill.body, enabled: true };
		const saved = await runPromise(Skills.Skills.use((skills) => skills.save(input, admins[skill.by]!)));
		if (!saved.ok) throw new Error(`${skill.name}: ${saved.error}`);
		await sql`update skills set created_at = ${ago(skill.ago)}, updated_at = ${ago(skill.ago)} where name = ${skill.name} and deleted_at is null`;
	}
	// The standard skills came with the server, a month ago.
	await sql`update skills set created_at = ${ago(DAY * 30)}, updated_at = ${ago(DAY * 30)} where name in ('docx', 'technical-writing') and deleted_at is null`;
}

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
		{ id: "demo-grant", title: "Grant application outline", updated: ago(DAY * 18), messages: grant() },
		...OTHER_CHATS.map((chat) => ({
			id: chat.id,
			title: chat.title,
			updated: ago(chat.ago),
			messages: [user(`${chat.id}-1`, ...(chat.skill ? [{ type: "data-skill", data: { name: chat.skill } }] : []), chat.ask), reply(`${chat.id}-2`, chat.model, chat.answer)],
		})),
	];
	for (const chat of chats) {
		await sql`delete from threads where id = ${chat.id}`;
		await sql`
			insert into threads (id, owner, title, messages, updated_at)
			values (${chat.id}, ${owner}, ${chat.title}, ${sql.json(chat.messages as never)}, ${chat.updated})`;
	}
}

// --- Workspaces -----------------------------------------------------------------

/**
 * A small PDF with one page for each entry of `pages`: a heading and a few lines of text.
 * The pages are what a person who opens the file sees, and what the log says it read.
 */
function pdf(pages: string[][]) {
	const escape = (line: string) => line.replace(/[\\()]/g, (char) => `\\${char}`);
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	const kids: string[] = [];
	for (const lines of pages) {
		const stream = lines.map((line, index) => `BT /F1 ${index === 0 ? 18 : 11} Tf 72 ${index === 0 ? 720 : 702 - index * 18} Td (${escape(line)}) Tj ET`).join("\n");
		kids.push(`${objects.length + 1} 0 R`);
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objects.length + 2} 0 R >>`);
		objects.push(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
	}
	objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`;
	let body = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const at = Buffer.byteLength(body);
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return at;
	});
	const xref = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(body, "latin1");
}

/** A PDF's pages from its sections: one section to a page, under the document's title. */
const pagesOf = (title: string, sections: [heading: string, ...lines: string[]][]) =>
	sections.map(([heading, ...lines], index) => [heading, ...lines, "", `${title} - page ${index + 1}`]);

/** The text that the indexing read, as a PDF's is kept: each page under "--- Page N ---". */
const pdfText = (pages: string[][]) => pages.map((lines, index) => `--- Page ${index + 1} ---\n\n${lines.join("\n")}`).join("\n\n");

const HANDBOOK_PAGES = pagesOf("Volunteer handbook 2026", [
	["Welcome to Riverside Food Bank", "Thank you for giving your time. Every shift packs food for about 340 families.", "This handbook covers your first shift, safety, and who to ask."],
	["Your first shift", "Arrive 10 minutes early and sign in at the front desk.", "Your shift lead gives you a role and a short tour.", "Wear closed shoes. We have gloves and aprons."],
	["Signing in and out", "Sign in on the tablet by the door, and sign out when you leave.", "Your hours count towards school and court-ordered service."],
	["Roles on the floor", "Sorting, packing, the pantry desk and the loading dock.", "Teens aged 14 to 17 can sort and pack with a parent or guardian on the same shift."],
	["Lifting and carrying", "Lift with your legs. Ask for help with anything over 25 lb.", "Only trained staff use the pallet jack."],
	["Food safety", "Milk, meat and eggs go into the cold room within 30 minutes.", "Throw away cans that are dented on the seam, bulging or leaking."],
	["Working with families", "Greet each family by name if you know it. Never ask why they come.", "Questions about benefits go to the pantry desk."],
	["If something goes wrong", "Tell your shift lead at once. The first aid kit is by the sink.", "For an injury, the lead fills in an incident form the same day."],
]);
const FOOD_SAFETY_PAGES = pagesOf("Food safety basics", [
	["Cold food", "Keep milk, meat and eggs at 41 F or colder.", "Check the cold-room thermometer at the start of each shift and write it in the log."],
	["Dates on food", "Best-by dates are about quality, not safety. Use-by dates on baby food are firm."],
	["Cans and jars", "Throw away cans that bulge, leak or are dented on the seam.", "Jars with a lid that pops go in the bin."],
	["Clean hands", "Wash your hands before each shift and after breaks.", "Change gloves when they tear or after you touch your face or phone."],
]);
const WAREHOUSE_PAGES = pagesOf("Warehouse safety rules", [
	["Before you start", "Wear closed shoes. Leave bags in the lockers by the office."],
	["The loading dock", "Stay behind the yellow line while a truck backs in.", "Only staff open the dock doors."],
	["Pallets and shelves", "Heavy boxes go on the lower shelves. Never climb the racks."],
]);
const FUND_PAGES = pagesOf("Riverside Community Fund guidelines 2027", [
	["Who can apply", "Nonprofits that serve people in Riverside County, with a budget under $2 million."],
	["What we fund", "Equipment, vehicles and building repairs: up to $25,000 for each application.", "We do not fund salaries or events."],
	["How to apply", "Answer the six questions below. Each answer is 300 words or less.", "Attach a budget and your latest annual report."],
	["The six questions", "1. The need  2. The plan  3. The budget", "4. The impact  5. Partners  6. Reporting"],
	["Dates", "Applications open on 6 January 2027 and close on 14 February 2027.", "We decide by 30 April 2027."],
]);
const ANNUAL_REPORT_PAGES = pagesOf(
	"Annual report 2025",
	Array.from({ length: 40 }, (_, index): [string, ...string[]] => [index === 0 ? "Riverside Food Bank: Annual report 2025" : `Annual report 2025: part ${index + 1}`, "Meals, volunteers and partners in 2025."]),
);

const ROLES_MD = `# Shift roles and duties

## Sorting
Check dates and packaging, and sort food into the bins by type. Ask the shift lead when you are not sure.

## Packing
Pack boxes from the list on the wall: one box for each family size. Heavy cans go at the bottom.

## Pantry desk
Greet families, check them in, and hand over their boxes. Two people at a time.

## Loading dock
Unload deliveries with a trained staff member. Closed shoes only.
`;
const SCHEDULE_CSV = `day,shift,start,end,lead,volunteers
Mon,Morning,09:00,12:00,Jordan Ellis,8
Tue,Evening,17:00,20:00,Fatima Rahman,10
Wed,Morning,09:00,12:00,Jordan Ellis,8
Thu,Evening,17:00,20:00,Fatima Rahman,10
Fri,Morning,09:00,12:00,Noah Bennett,12
Sat,Family,10:00,13:00,Aiko Tanaka,24
`;
const BUDGET_CSV = `item,cost,funded_by
Refrigerated van (used 2023),54500,
Insurance for the first year,3800,
Signs on the van,2500,Local print shop (in kind)
Driver training and food safety,1200,
Raised already,-48000,Board and donors
Asked of the fund,14000,
`;
const LAST_YEAR_MD = `# Application to the Riverside Community Fund, 2026

## 1. The need
We turned away about 900 lb of fresh food each week because we could not keep it cold.

## 2. The plan
A second walk-in cooler at the warehouse, run by our facilities volunteer.

## 3. The budget
Cooler and installation: $18,400. Asked of the fund: $15,000.

## Outcome
Funded in full in April 2026. The cooler has run since June.
`;

type DemoDocument = { id: string; name: string; mediaType: string; data: Buffer; text: string; pages?: string[][]; pictures?: number[]; added: number; reading?: { modelPages: number; read: number } };
type DemoWorkspace = {
	id: string;
	slug: string;
	name: string;
	owner: string;
	orgAccess: "none" | "ask";
	instructions: string;
	made: number;
	members: [userId: string, access: "ask" | "edit"][];
	pinned: boolean;
	documents: DemoDocument[];
	chats: { id: string; title: string; ago: number; model: string; ask: string; answer: string }[];
};

const PICTURE_MODEL = GEMINI;
const EMBEDDING_MODEL = "openai/text-embedding-3-small";

/**
 * Alex's workspaces, and one that Jordan opened to everyone. Each shows a state of the workspace
 * page: set up and in use, shared with people in roles, set up in part, and brand new (the setup
 * cards). Documents are written Ready, with the log that indexing would have written, and with no
 * passages: no model is called. One is still Indexing, a model on page 12 of 40.
 */
function workspaces(demo: string, others: string[]): DemoWorkspace[] {
	const [jordan, sam, lena, diego, , , fatima] = others;
	const handbook = pdf(HANDBOOK_PAGES);
	const foodSafety = pdf(FOOD_SAFETY_PAGES);
	const fund = pdf(FUND_PAGES);
	const annualReport = pdf(ANNUAL_REPORT_PAGES);
	return [
		{
			id: "demo-ws-handbook",
			slug: "volunteer-handbook",
			name: "Volunteer handbook",
			owner: demo,
			orgAccess: "ask",
			made: DAY * 30,
			members: [
				[jordan!, "edit"],
				[fatima!, "edit"],
			],
			pinned: true,
			instructions: [
				"Answer volunteers' questions from Sources, in a warm, plain voice: many of them are new.",
				"",
				"- Lead with the answer in one or two sentences, then name the section and page.",
				"- If Sources don't cover it, say so, and suggest asking the shift lead.",
			].join("\n"),
			documents: [
				{ id: "demo-doc-handbook", name: "Volunteer handbook 2026.pdf", mediaType: "application/pdf", data: handbook, text: pdfText(HANDBOOK_PAGES), pages: HANDBOOK_PAGES, pictures: [2, 5], added: DAY * 30 },
				{ id: "demo-doc-roles", name: "Shift roles and duties.md", mediaType: "text/markdown", data: Buffer.from(ROLES_MD), text: ROLES_MD, added: DAY * 29 },
				{ id: "demo-doc-food-safety", name: "Food safety basics.pdf", mediaType: "application/pdf", data: foodSafety, text: pdfText(FOOD_SAFETY_PAGES), pages: FOOD_SAFETY_PAGES, added: DAY * 29 },
				{ id: "demo-doc-schedule", name: "Shift schedule.csv", mediaType: "text/csv", data: Buffer.from(SCHEDULE_CSV), text: SCHEDULE_CSV, added: DAY * 12 },
			],
			chats: [
				{ id: "demo-ws-teens", title: "Can teens volunteer on Saturdays?", ago: DAY + hours(5), model: SONNET, ask: "A mum asked if her 15-year-old can come on Saturdays. Can she?", answer: "Yes, with her mum on the same shift. Teens aged 14 to 17 can sort and pack when a parent or guardian is there too (Roles on the floor, page 4)." },
				{ id: "demo-ws-injury", title: "What to do if a volunteer gets hurt", ago: DAY * 3, model: SONNET, ask: "Someone cut their hand on a box. What do I do?", answer: "Get the first aid kit by the sink, and tell your shift lead at once. The lead fills in an incident form the same day (If something goes wrong, page 8)." },
				{ id: "demo-ws-cans", title: "Dented cans: keep or throw away?", ago: DAY * 5, model: FLASH, ask: "Is a can with a small dent on the side okay to give out?", answer: "A small dent on the side is fine. Throw it away if the dent is on the seam, or if the can bulges or leaks (Food safety basics, page 3)." },
			],
		},
		{
			id: "demo-ws-grants",
			slug: "grant-applications",
			name: "Grant applications",
			owner: demo,
			orgAccess: "none",
			made: DAY * 20,
			members: [
				[lena!, "edit"],
				[sam!, "ask"],
				[diego!, "ask"],
			],
			pinned: true,
			instructions: [
				"Help draft grant applications for Riverside Food Bank.",
				"",
				"- Use the funder's guidelines in Sources for the headings, the word limits and what they fund.",
				"- Every number comes from our budget or the annual report. Mark anything else [check].",
				"- Write \"we\", not \"the organization\".",
			].join("\n"),
			documents: [
				{ id: "demo-doc-fund", name: "Riverside Community Fund guidelines.pdf", mediaType: "application/pdf", data: fund, text: pdfText(FUND_PAGES), pages: FUND_PAGES, added: DAY * 20 },
				{ id: "demo-doc-budget", name: "Van budget 2027.csv", mediaType: "text/csv", data: Buffer.from(BUDGET_CSV), text: BUDGET_CSV, added: DAY * 19 },
				{ id: "demo-doc-last-year", name: "Our 2026 application.md", mediaType: "text/markdown", data: Buffer.from(LAST_YEAR_MD), text: LAST_YEAR_MD, added: DAY * 19 },
				{ id: "demo-doc-annual-report", name: "Annual report 2025.pdf", mediaType: "application/pdf", data: annualReport, text: "", pages: ANNUAL_REPORT_PAGES, added: minutes(2), reading: { modelPages: 30, read: 2 } },
			],
			chats: [
				{ id: "demo-ws-capital", title: "Does the fund pay for a van?", ago: DAY * 2 + hours(2), model: OPUS, ask: "Can we ask the Riverside Community Fund for a van, or only for buildings?", answer: "Yes: the fund pays for equipment, vehicles and building repairs, up to $25,000 an application. It does not pay for salaries or events (What we fund, page 2)." },
				{ id: "demo-ws-budget", title: "Budget table for the van", ago: DAY * 4, model: OPUS, ask: "Make the budget table for the van from our budget file.", answer: "Here is the table: the van $54,500, insurance $3,800, signs $2,500 and training $1,200, for a total of $62,000. With $48,000 raised, we ask for $14,000." },
			],
		},
		{
			id: "demo-ws-board",
			slug: "board-meetings",
			name: "Board meetings",
			owner: demo,
			orgAccess: "none",
			made: DAY * 6,
			members: [],
			pinned: false,
			instructions: "Prepare board papers and minutes. Minutes have the decisions, the actions with an owner and a date, and the open questions. Keep each paper to one page.",
			documents: [],
			chats: [],
		},
		{ id: "demo-ws-events", slug: "events-2027", name: "Events 2027", owner: demo, orgAccess: "none", made: minutes(6), members: [], pinned: false, instructions: "", documents: [], chats: [] },
		{
			id: "demo-ws-warehouse",
			slug: "warehouse-safety",
			name: "Warehouse safety",
			owner: jordan!,
			orgAccess: "ask",
			made: DAY * 25,
			members: [],
			pinned: false,
			instructions: "Answer questions about safety in the warehouse from the rules in Sources. If someone is hurt, the first answer is: tell the shift lead now.",
			documents: [{ id: "demo-doc-warehouse", name: "Warehouse safety rules.pdf", mediaType: "application/pdf", data: pdf(WAREHOUSE_PAGES), text: pdfText(WAREHOUSE_PAGES), pages: WAREHOUSE_PAGES, added: DAY * 25 }],
			chats: [],
		},
	];
}

/** The indexing log of a document, as the indexer writes it (server/workspaces/documents/log.ts): numbers only. */
function logRows(document: DemoDocument, workspaceId: string) {
	const rows: { id: string; step: string; detail: Record<string, string | number | boolean>; at: Date }[] = [];
	let at = now - document.added;
	const add = (step: string, detail: Record<string, string | number | boolean>, part?: number, seconds = 1) => {
		at += seconds * 1000;
		rows.push({ id: [document.id, 1, step, ...(part === undefined ? [] : [part])].join(":"), step, detail, at: new Date(at) });
	};
	add("uploaded", { size: document.data.length, mediaType: document.mediaType }, undefined, 0);
	const chars = document.pages ? document.pages.flat().join("\n").length : document.text.length;
	if (document.pages) add("parsed", { engine: "liteparse", pages: document.pages.length, chars, ms: 640 });
	const pictures = document.reading ? [3, 4] : (document.pictures ?? []);
	for (const page of pictures) {
		add("page-read", { page, reason: "picture", model: PICTURE_MODEL, ms: 2_400, ok: true, attempts: 1, inputTokens: 1_850, outputTokens: 420 }, page, 3);
	}
	if (!document.reading) {
		const passages = Math.max(2, Math.ceil(chars / 400));
		add("chunked", { passages, batches: 1 });
		add("embedded", { batch: 0, passages, model: EMBEDDING_MODEL, ms: 380 }, 0);
		add("ready", { passages, ms: Math.round(at - (now - document.added)) + 400 });
	}
	return rows.map((row) => ({ ...row, workspaceId }));
}

async function addWorkspaces(demo: string, others: string[]) {
	for (const workspace of workspaces(demo, others)) {
		const made = ago(workspace.made);
		await sql`
			insert into workspaces (id, slug, org_access, owner_id, name, instructions, created_at, updated_at)
			values (${workspace.id}, ${workspace.slug}, ${workspace.orgAccess}, ${workspace.owner}, ${workspace.name}, ${workspace.instructions}, ${made}, ${made})`;
		for (const [userId, access] of workspace.members) {
			await sql`insert into workspace_members (workspace_id, user_id, access, added_by, added_at) values (${workspace.id}, ${userId}, ${access}, ${workspace.owner}, ${made})`;
		}
		if (workspace.pinned) await sql`insert into workspace_pins (user_id, workspace_id, pinned_at) values (${demo}, ${workspace.id}, ${made})`;
		for (const document of workspace.documents) await addDocument(workspace, document);
		for (const chat of workspace.chats) {
			const messages = [user(`${chat.id}-1`, chat.ask), reply(`${chat.id}-2`, chat.model, chat.answer)];
			await sql`
				insert into threads (id, owner, title, messages, updated_at, workspace_id)
				values (${chat.id}, ${demo}, ${chat.title}, ${sql.json(messages as never)}, ${ago(chat.ago)}, ${workspace.id})`;
		}
	}
}

/**
 * One document, Ready with its log; or Indexing, a model partway through its picture pages
 * (store.ts, progressOf). The bytes are in the row, as when no bucket is set up. An Indexing
 * document that waits more than 5 minutes is started again by the server's sweep, and fails
 * on the demo key: run the seed again before its image.
 */
async function addDocument(workspace: DemoWorkspace, document: DemoDocument) {
	const added = ago(document.added);
	const reading = document.reading;
	await sql`
		insert into workspace_documents (id, workspace_id, name, media_type, size, data, text, status, added_by, created_at, reading_since, page_count, model_pages)
		values (${document.id}, ${workspace.id}, ${document.name}, ${document.mediaType}, ${document.data.length}, ${document.data}, ${reading ? null : document.text},
			${reading ? "reading" : "ready"}, ${workspace.owner}, ${added}, ${added}, ${document.pages?.length ?? null}, ${reading?.modelPages ?? document.pictures?.length ?? null})`;
	for (const row of logRows(document, workspace.id)) {
		await sql`
			insert into workspace_document_log (id, document_id, workspace_id, generation, step, detail, created_at)
			values (${row.id}, ${document.id}, ${row.workspaceId}, 1, ${row.step}, ${sql.json(row.detail)}, ${row.at})`;
	}
	for (let page = 1; page <= (reading?.read ?? 0); page += 1) {
		await sql`insert into workspace_page_reads (document_id, generation, page, record) values (${document.id}, 1, ${page + 2}, ${sql.json({ page: page + 2, ok: true })})`;
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
await addWorkspaces(userId, others);
await addMemories(userId);
await addConnector(userId);
await addSkills([userId, others[0]!, userId]);
await addUsage(userId, others);
if (cookieFile) writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
console.log(`Seeded ${DEMO_EMAIL} (${userId}) and ${others.length} other people.${cookieFile ? ` Cookies: ${cookieFile}` : ""}`);
process.exit(0);
