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
];
