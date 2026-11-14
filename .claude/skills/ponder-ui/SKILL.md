---
name: ponder-ui
description: Ponder Chat's visual rules for new pages and features in the chat and /admin. These cover tones, spacing, headings, empty, error and loading states, dates and numbers, motion, touch, and the frappe-ui traps that break them. Use it when you build or change any screen, component or state under web/, and before you say UI work is done.
---

# Ponder UI

These rules took the chat and /admin from 6.5 to 10/10 in two design councils. Follow them so that a new screen looks as if it was always there. When a rule and a design idea disagree, follow the rule. Change the rule only on purpose, and update this file in the same commit.

## Before you write code

- Find the nearest existing screen and copy its structure. Overview and Person are the admin models. ChatView and MemoryView are the chat models.
- Use the shared helpers. Do not write a second version of any of them:

| Need | Use |
| --- | --- |
| Empty, error or offline state | `web/EmptyState.vue` (`icon`, `title`, `body`, `alert`, slot for one action) |
| A date or time | `web/dates.ts`: `when()` ("3 hours ago", then "5 Nov"), `fullDate()`, `clockTime()`, `fromNow()`, `shortDay()` |
| A count or credits | `web/numbers.ts`: `count()`, `credits()`. Money: `money()` / `dollars()` in `web/admin/lib/format.ts` |
| Rules for both apps (easing, placeholders, dialogs, touch, header hairline) | `web/base.css` |
| Admin lock footnote | `web/admin/components/PrivacyNote.vue` |
| A bigger hit area on touch | the `touch-target` class |
| Edge fades on a scroller | `scroll-fade-y` / `scroll-fade-x` with `[--scroll-fade-size:Npx] [--scroll-fade-range:Npx]` |

## Rules

### Text tones (frappe-ui `ink` tokens)

- gray-9 for page and section headings.
- gray-8 for primary content and values.
- gray-6 for content text: row metadata, emails, descriptions, intros, empty-list lines, status text such as "Not saved", the chat list's group labels and the "/ limit" denominators.
- gray-5 for field help text, footnotes and xs timestamps. It is below 4.5:1 on white and on the sidebar, so Lighthouse flags it on text people need to read.
- gray-4 only for icons and the "—" placeholder.
- One red for errors and empty credits: `text-ink-red-6`. Use amber for "running low".

### Headings and titles

- Admin section heading: `text-base-semibold text-ink-gray-9`, 12px above its content (`space-y-3`).
- A card or chart title names what it shows. The period and totals go in the subtitle: "Credits used per day" over "Last 30 days · 48.3 credits · $0.05".
- A KPI card with a period reads "Noun, last N days". Name periods "Last N days". Something that has not happened reads "Never".
- Separate metadata with " · " (a word space each side) and use curly quotes (“…”) around names.

### Spacing

- Admin page body: `px-3 pt-4 sm:px-5 md:pt-6`. Sections are `space-y-8`. Sibling cards are 16px apart (`gap-4` / `space-y-4`) everywhere.
- The chat column is 720px. Replies, bubbles, cards and the composer share one right edge.
- Each screen picks one axis. Either everything starts on one leading edge, or the whole group is centred (sign-in, empty states, the greeting). A label, field or button never starts a second, left edge under a centred heading.
- The chat header title, the transcript, Memory and the composer share one leading edge. Anything in the chat area outside a scroller (header, composer, loading skeleton) uses `scroll-gutter-match` in `web/style.css`, which adds the transcript's scrollbar gutter. That class owns the width and side padding, so do not put `mx-auto`, `max-w-*` or `px-*` next to it.
- Sidebars have two edges: 16px for glyphs and text-only rows (icons, chat titles, group labels, credits), and 40px for a label after an icon (search, nav items, New chat). Content inside a full-width sidebar button starts on those edges, not centred.
- Blocks in a reply (steps, text, cards) are 16px apart. The copy and model row sits 10px under the reply because it belongs to it.
- Rows that share a list or panel share one pitch.
- Check alignment with numbers, not by eye (see "Check your work").

### States

- **Empty:** use `EmptyState`. Hide table column headers when there are no rows.
- **Error:** a failed load replaces what failed, including the header actions that act on it, such as Save. It never sits over old content or skeletons. Say "X could not load" and "Try again". Keep "Retry" only for regenerating a reply.
- **Loading:** keep the loaded layout. Fixed text (labels, headings, header actions, footnotes) stays as text, with buttons disabled. Skeleton bars go only where values go. Size each bar's line from the text it stands for: wrap it in `flex h-[1lh] items-center` with the same type class. Then measure that nothing moves when the data arrives.
- **Missing:** keep the page's header and breadcrumb, and use `EmptyState` inside the body padding.

### Formats

- Every date or time comes from `web/dates.ts`, and every number from `web/numbers.ts`. Never call `toLocaleDateString`, `toLocaleString` or `Intl` directly in a component.
- NumberCard: pass the raw number and a `:format` function, so the count-up still works. A string value shows at once and does not animate.

### Motion

- Use one curve, `ease-out-strong`, for 120–300ms, and transition named properties (no `transition-all`).
- Add a `motion-reduce:` path for every transform or animation.
- Chart motion follows `chartMotion`, which is off with reduced motion.

### Headers and scrolling

- The header hairline shows only when content scrolls under it. A new scroller in the chat column or /admin gets this through `base.css` and the scroll timelines in `style.css` and `admin/style.css`. Make sure your scroller sits on that timeline.
- Lists and tables that scroll get edge fades, not borders.

### Touch (`pointer: coarse`)

- Every control reaches 44px. Use `touch-target`, an invisible area that does not move the layout. Phone admin headers and segmented tabs already get it.
- Never reach 44px by growing a row's layout height (`min-h-11`) in a chat reply: it pushes text and steps apart. Use the invisible area. Step rows stacked in an open fold or a run of steps are the one exception to 44px: on touch they sit 12px apart, and their areas fill exactly that gap (32px a row, `base.css`).
- Neighbouring areas must not overlap. Add touch-only spacing such as `[@media(pointer:coarse)]:gap-x-2`, or let a row grow to `min-h-11` when targets are stacked close together.

### Dark mode

- Check every new surface in dark mode. Cards need visible edges.
- Dashboard cards and charts get the label lift with `data-slot="dashboard"` on the card itself, never on the whole page.

## frappe-ui traps we hit

- **Button colour:** Button's variant colour (`text-ink-gray-8`) beats a plain colour class. Use `!text-ink-gray-6`, then check the computed colour.
- **CSS order:** an arbitrary utility can lose to a later unlayered rule. `.scroll-fade-y` beat `[animation-range:…]`, for example. Use the CSS variable the rule reads, then check the computed style.
- **MobileNavItem:** it treats a missing `active` as false. Pass `:active` on every item.
- **Breadcrumbs:** the last crumb gets the current-page tone. While loading, draw "Parent / bar" yourself rather than passing a lone parent crumb or an empty one.
- **Hidden elements:** an `sr-only` element still takes margin inside `space-y-*`. Use `aria-label` on the container instead.
- **Template whitespace:** Vue trims leading spaces inside elements, so use `ml-1`, not `" text"`.
- **Fixed internals:** NumberCard takes text values and has a 2.4px-taller skeleton. DonutChart and ChartContainer fix their own sizes and title styles. Treat these as limits; do not override them.

## Check your work

Do not report UI work as done until you have done all of these:

1. `npm run typecheck` and `npm run build` pass.
2. Screenshot the new or changed screens at 1440×900 and 390×844, in light and dark, with real data. Also capture the empty, error and loading states. To hold a load open, patch `window.fetch` to return a promise that never resolves for that API, then navigate.
3. For every change that depends on CSS order or a frappe-ui default, check the computed style in the browser. Seeing the class in the source or the built CSS is not enough.
4. Measure alignment and "nothing moves on load" with `getBoundingClientRect()`. Compare the loading positions with the loaded ones.
5. If a screenshot comes back byte-identical to the last one, check that the session is still signed in and that the change really landed.
6. For a larger change, compare each screen side by side with `main`. Mark the changes that are easy to miss.
