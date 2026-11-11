// The README screenshots, for the clean-ui-shot scripts (scripts/demo/README.md).
// Each shot opens a chat that scripts/demo/seed.ts wrote. DEMO_COOKIES names the cookie
// file that the seed wrote, so every shot is signed in as the demo person.
import { readFileSync } from 'node:fs';

const cookies = JSON.parse(readFileSync(process.env.DEMO_COOKIES ?? '', 'utf8'));
const signIn = async (context) => context.addCookies(cookies);

/** Waits for the chat to load and the scroller to settle at its end. */
async function openChat(page, text) {
  await page.getByText(text).first().waitFor();
  await page.waitForTimeout(800);
}

/** Selects `text` inside the replies, as a person would with the mouse. */
async function selectInReply(page, text) {
  await page.evaluate((text) => {
    const root = document.querySelector('[data-cite-source]') ?? document.body;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.data.indexOf(text);
      if (at === -1 || !node.parentElement?.closest('[data-cite-source]')) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    throw new Error(`not found: ${text} in ${root.textContent?.slice(0, 80)}`);
  }, text);
}

// Every shot is a 16:9 window, 1280×720 CSS px, captured at 3× (3840×2160 px) and
// shrunk onto the stage with Lanczos. A 1920 px wide window would spread the 720 px
// chat column over a wide empty page and shrink its text past reading at README
// width. Crops keep at least one edge of the window (padded) and bleed on the
// others, so each reads as a detail of the app. Crops are measured from the page, so
// they follow the layout and end in white space, never through text.
const HD = { width: 1280, height: 720 };

/** The page box of the first match. */
const boxOf = async (locator) => locator.first().boundingBox();

/**
 * The chat column from the window's top-right corner down to `bottom`: it starts
 * `margin` px left of the message box and bleeds left through the sidebar's edge.
 */
async function columnCrop(page, bottom, margin = 140) {
  const composer = await boxOf(page.locator('footer [data-slot="prompt-input"]'));
  const { width, height } = page.viewportSize();
  const x = Math.round(composer.x - margin);
  return { x, y: 0, w: width - x, h: Math.round(Math.min(bottom, height)) };
}

/** `gap` px under the bottom of the first match. */
const under = async (locator, gap = 32) => {
  const box = await boxOf(locator);
  return box.y + box.height + gap;
};

/**
 * Scrolls the open chat to its first message. The "Scroll to end" button that then
 * shows is a passing control, not part of the feature, so it is hidden.
 */
async function scrollToTop(page) {
  await page.mouse.move(760, 300);
  for (let i = 0; i < 6; i += 1) await page.mouse.wheel(0, -1500);
  await page.addStyleTag({ content: 'button[aria-label="Scroll to end"] { visibility: hidden !important; }' });
  await page.waitForTimeout(600);
}

const item = (page, text) => page.locator('li', { hasText: text });

/** The part of a reply that the queue shot shows on its way: it stops mid-sentence. */
const THANK_YOU = `Here is a short thank-you to send the day after a first shift. It names the shift, thanks them for one thing they did, and asks how it went.

**Subject:** Thank you for Saturday

Hi Priya,

Thank you for coming in on Saturday. The forty boxes you packed went out to families the same afternoon, and`;

/**
 * Answers the next message with `text` and then holds the reply open, so the chat stays
 * busy and the messages sent after it wait in the queue. The demo server has no real
 * OpenRouter key, so a reply cannot run. The POST gets the start of the reply with no
 * finish, and the transport's reconnect (a GET) never gets an answer.
 */
async function holdReply(context, text) {
  const chunks = [
    { type: 'start', messageId: 'demo-on-its-way', messageMetadata: { model: 'deepseek/deepseek-v4.1-flash' } },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    { type: 'text-delta', id: 't1', delta: text },
  ];
  await context.route('**/api/chat', (route) =>
    route.request().method() !== 'POST'
      ? route.continue()
      : route.fulfill({
          status: 200,
          headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'x-workflow-run-id': 'demo-on-its-way' },
          body: chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join(''),
        }),
  );
  await context.route('**/api/chat/demo-on-its-way/stream**', () => {});
}

// The admin pages. The sidebar is 16rem wide: a crop that starts at MAIN_X bleeds left
// through the margin of the main area, not through the sidebar's labels.
const MAIN_X = 256;
const ADMIN = { width: 1280, height: 800 };

/** Waits for an admin page and its charts. */
async function settleAdmin(page) {
  await page.waitForLoadState('networkidle');
  await page.addStyleTag({ content: '* { scrollbar-width: none !important; }' });
  await page.waitForTimeout(1200);
}

/** The card (rounded box) that holds `text`. */
const cardOf = (page, text) => page.getByText(text, { exact: true }).locator('xpath=ancestor::div[contains(@class, "rounded")][1]');

export default [
  {
    // The whole window, all four edges: chats, a reply with sources, a memory note, credits.
    name: 'hero',
    path: '/?t=demo-heat-pumps',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await openChat(page, 'What to ask the installer');
      await scrollToTop(page);
    },
  },
  {
    // Top-right corner: the search steps unfolded, and the card of a citation chip.
    name: 'citations',
    path: '/?t=demo-heat-pumps',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await openChat(page, 'What to ask the installer');
      await page.getByText('Looked up 2 things').click();
      await page.waitForTimeout(500);
      await scrollToTop(page);
      this.crop = await columnCrop(page, await under(item(page, 'Efficiency falls')));
    },
    async beforeShot({ page }) {
      await page.locator('a[data-citation]').nth(2).hover();
      await page.locator('[data-slot="citation-card"]').waitFor();
    },
  },
  {
    // Top-right corner: text selected in a reply, with the Cite button under it.
    name: 'cite',
    path: '/?t=demo-lisbon',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await openChat(page, 'Day 1: Alfama');
      this.crop = await columnCrop(page, await under(item(page, 'Walk along the river'), 10));
      await selectInReply(page, 'Take tram 28 early, before 9 am');
      await page.locator('[data-cite-button]').waitFor();
    },
  },
  {
    // Bottom-right corner: the quote marked in the reply, its chip in the message box, and the comment.
    name: 'cite-comment',
    path: '/?t=demo-lisbon',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await openChat(page, 'Day 1: Alfama');
      const top = (await boxOf(page.getByText('Here is a relaxed plan'))).y - 32;
      const crop = await columnCrop(page, HD.height);
      this.crop = { ...crop, y: Math.round(top), h: Math.round(HD.height - top) };
      await selectInReply(page, 'Take tram 28 early, before 9 am');
      await page.locator('[data-cite-button]').click();
      await page.getByLabel('Comment on the quoted text').fill('We have a stroller. Is the tram still a good idea?');
    },
  },
  {
    // Top-right corner: a slide deck in the side panel, bleeding down through the slides.
    name: 'slides',
    path: '/?t=demo-deck',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await openChat(page, 'Here is the deck');
      await page.getByLabel('Open Q3 volunteer report').click();
      await page.waitForTimeout(1200);
      const title = await boxOf(page.locator('[data-slot="chat-header"] h1'));
      const x = Math.round(title.x - 48);
      const composer = await boxOf(page.locator('footer [data-slot="prompt-input"]'));
      this.crop = { x, y: 0, w: HD.width - x, h: Math.round(composer.y - 20) };
    },
  },
  {
    // Top-right corner: a CSV that Python wrote, open in the side panel as a table. Starts at
    // the sidebar's edge and bleeds down through the rows.
    name: 'table',
    path: '/?t=demo-students',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await openChat(page, 'report-card template');
      await page.locator('[data-slot="attachment"]', { hasText: 'students.csv' }).click();
      await page.getByText('100 rows').waitFor();
      await page.waitForTimeout(600);
      const sidebar = await boxOf(page.locator('[data-slot="sidebar"]'));
      const composer = await boxOf(page.locator('footer [data-slot="prompt-input"]'));
      const x = Math.round(sidebar.x + sidebar.width);
      this.crop = { x, y: 0, w: HD.width - x, h: Math.round(composer.y - 20) };
    },
  },
  {
    // The whole window: present mode, one slide full screen.
    name: 'present',
    path: '/?t=demo-deck',
    viewport: HD,
    routes: signIn,
    stage: 'dark',
    async setup({ page }) {
      await openChat(page, 'Here is the deck');
      await page.getByLabel('Open Q3 volunteer report').click();
      await page.waitForTimeout(1000);
      await page.getByRole('button', { name: 'Present' }).click();
      await page.waitForTimeout(800);
      await page.keyboard.press('ArrowRight');
      await page.mouse.move(640, 300);
      await page.waitForTimeout(800);
    },
  },
  {
    // Top-right corner: a CSV in, a chart and an answer out. Taller, for the chart.
    name: 'python',
    path: '/?t=demo-cafe',
    viewport: { width: 1280, height: 960 },
    routes: signIn,
    async setup({ page }) {
      await openChat(page, 'sells the most');
      await scrollToTop(page);
      this.crop = await columnCrop(page, await under(page.locator('[data-slot="memory-saved"]')));
    },
  },
  {
    // Bottom-right corner: a reply still on its way, and two messages queued behind it.
    name: 'queue',
    path: '/?t=demo-email',
    viewport: HD,
    async routes(context) {
      await signIn(context);
      await holdReply(context, THANK_YOU);
    },
    async setup({ page }) {
      await openChat(page, 'keeps the one link');
      const field = page.locator('footer [data-slot="prompt-input"] textarea');
      const ask = 'Now write the thank-you email for after their first shift.';
      for (const text of [ask, 'Add a line about parking at the back entrance', 'Then translate both emails into Spanish']) {
        await field.fill(text);
        await field.press('Enter');
        await page.waitForTimeout(400);
      }
      await page.locator('[data-slot="prompt-input-queue-item"]').nth(1).waitFor();
      await page.mouse.move(0, 0);
      await page.waitForTimeout(800);
      const question = await boxOf(page.getByText(ask, { exact: true }).last());
      const composer = await boxOf(page.locator('footer [data-slot="prompt-input"]'));
      const { width, height } = page.viewportSize();
      const x = Math.round(composer.x - 140);
      const y = Math.round(question.y - 32);
      this.crop = { x, y, w: width - x, h: height - y };
    },
  },
  {
    // Top-right corner: a connector tool that changes something waits for the person.
    name: 'approval',
    path: '/?t=demo-linear',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await openChat(page, 'File a bug in Linear');
      await page.getByText('Show details').click();
      await page.waitForTimeout(500);
      this.crop = await columnCrop(page, await under(page.getByText('nobody can sign up'), 56));
    },
  },
  {
    // Top-right corner: the Memory page, bleeding down through the list.
    name: 'memory',
    path: '/?view=memory',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await page.getByText('Lives in Minneapolis').first().waitFor();
      const list = await boxOf(page.getByText('Lives in Minneapolis'));
      const bottom = await under(page.getByText('Prefers short answers'), 24);
      const x = Math.round(list.x - 152);
      this.crop = { x, y: 0, w: HD.width - x, h: Math.round(Math.min(bottom, HD.height)) };
    },
  },
  {
    // Top-left corner: one connector's tools, each on Always allow, Ask first or Off.
    // The crop keeps the dimmed sidebar whole and bleeds right, through the backdrop.
    name: 'connectors',
    path: '/?settings=connectors',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await page.getByLabel('Open Linear').click();
      await page.getByText('Create issue').first().waitFor();
      await page.waitForTimeout(600);
      const dialog = await boxOf(page.getByRole('dialog'));
      this.crop = { x: 0, y: 0, w: Math.round(dialog.x + dialog.width + 64), h: Math.round(Math.min(dialog.y + dialog.height + 48, HD.height)) };
    },
  },
  {
    // Right edge: the model picker in the message box.
    name: 'models',
    path: '/',
    viewport: HD,
    routes: signIn,
    async setup({ page }) {
      await page.getByText("What's on your mind?").waitFor();
      await page.getByRole('button', { name: /^Model:/ }).click();
      await page.waitForTimeout(600);
      const top = (await boxOf(page.getByPlaceholder('Find a model'))).y - 48;
      const bottom = await under(page.getByText('Chart compound interest'), 48);
      const crop = await columnCrop(page, HD.height);
      this.crop = { ...crop, y: Math.round(top), h: Math.round(bottom - top) };
    },
  },
  {
    // Top edge and both sides: the admin overview, bleeding down through the charts.
    name: 'admin',
    path: '/admin',
    viewport: { width: 1280, height: 960 },
    routes: signIn,
    async setup({ page }) {
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);
      const chart = await boxOf(page.getByText('Credits used per day'));
      this.crop = { x: 0, y: 0, w: 1280, h: Math.round(chart.y + 230) };
    },
  },
  {
    // Top-right corner: everyone with an account and the open invites. Bleeds left and down.
    name: 'admin-people',
    path: '/admin/people',
    // Tall enough that the list does not scroll, so no scrollbar shows.
    viewport: { width: 1280, height: 900 },
    routes: signIn,
    async setup({ page }) {
      await settleAdmin(page);
      const last = await boxOf(page.getByText('kofi@example.net'));
      const x = MAIN_X;
      this.crop = { x, y: 0, w: 1280 - x, h: Math.round(last.y + last.height + 26) };
    },
  },
  {
    // Top-right corner: one person's numbers, credits per day, details and devices. Bleeds left and down.
    name: 'admin-person',
    path: '/admin/people',
    viewport: { width: 1280, height: 900 },
    routes: signIn,
    async setup({ page }) {
      await settleAdmin(page);
      await page.getByRole('link', { name: 'Sam Okafor', exact: true }).click();
      await settleAdmin(page);
      const daily = await boxOf(cardOf(page, 'Credits used per day'));
      this.crop = { x: MAIN_X, y: 0, w: 1280 - MAIN_X, h: Math.round(daily.y + daily.height + 14) };
    },
  },
  {
    // Bottom-left corner: the foot of the sidebar, credits and active people over time. Bleeds up and right.
    name: 'admin-usage',
    path: '/admin',
    viewport: { width: 1280, height: 960 },
    routes: signIn,
    async setup({ page }) {
      await settleAdmin(page);
      const daily = await boxOf(cardOf(page, 'Credits used per day'));
      const active = await boxOf(cardOf(page, 'Active people per day'));
      const y = Math.round(daily.y - 52);
      this.crop = { x: 0, y, w: Math.round(active.x + active.width + 10), h: 960 - y };
    },
  },
  {
    // Bottom-right corner: credits by model.
    name: 'admin-models',
    path: '/admin',
    viewport: { width: 1280, height: 960 },
    routes: signIn,
    stageW: 600,
    async setup({ page }) {
      await settleAdmin(page);
      const active = await boxOf(cardOf(page, 'Active people per day'));
      const models = await boxOf(cardOf(page, 'Credits by model'));
      const x = Math.round(active.x + active.width + 10);
      const y = Math.round(models.y - 10);
      this.crop = { x, y, w: 1280 - x, h: 960 - y };
    },
  },
  {
    // Right edge: a person's actions, from the row's menu.
    name: 'admin-actions',
    path: '/admin/people',
    viewport: ADMIN,
    routes: signIn,
    stageW: 680,
    async setup({ page }) {
      await settleAdmin(page);
      await page.getByRole('button', { name: 'Actions for Sam Okafor' }).click();
      await page.getByRole('menuitem', { name: 'Ban' }).waitFor();
      const menu = await boxOf(page.getByRole('menu'));
      const row = await boxOf(page.getByText('noah@example.net'));
      const credits = await boxOf(page.getByText('Credits today', { exact: true }));
      const x = Math.round(credits.x - 120);
      const y = Math.round(row.y - 24);
      this.crop = { x, y, w: ADMIN.width - x, h: Math.round(menu.y + menu.height + 64 - y) };
    },
  },
];
