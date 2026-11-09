# Ponder Chat on Astryx

A port of the chat page (`web/`, Vue and frappe-ui) to React 19 and the [Astryx](https://github.com/meta/astryx) design system. The admin pages (`/admin`) stay in Vue. The server and its API do not change.

## Run it

1. Start a Ponder server (see the project README). Add the dev page's address to its `PONDER_HOSTS`, for example `127.0.0.1:5195,localhost:5195`. Vite sends `/api` and `/oauth` to the server and keeps the page's Host, so sign-in, links in emails and connector callbacks all use the dev page's address.
2. `npm install`, then `PONDER_SERVER=http://127.0.0.1:3500 npm run dev`. The page is on http://127.0.0.1:5195.
3. `npm run typecheck` checks the types. `npm run build` writes `../dist-astryx`, to look at.

## Ship it

In the project folder, `npm run build:astryx` builds the admin pages (Vue), then this chat into `dist/` over the Vue chat's `index.html`, then the server. The server serves `dist/` as before: the React chat at `/`, the admin pages at `/admin`. `npm run build` still builds the Vue chat.

## How it is built

- Astryx components for everything they cover: `AppShell` and `SideNav` for the frame, the `Chat` family (`ChatLayout`, `ChatMessageList`, `ChatMessage`, `ChatComposer`, `ChatToolCalls`) for the conversation, `Markdown` for replies.
- Model Markdown (replies, reasoning, documents) goes through one component, `src/chat/markdown/ChatMarkdown.tsx`: Astryx `Markdown` with KaTeX maths, Mermaid diagrams drawn by Pele, and single newlines as line breaks. KaTeX and Pele load on first use.
- Layout and small styles use Tailwind v4 through Astryx's token bridge (`src/styles.css`): `text-secondary`, `bg-surface`, `border-border`. No hardcoded colours or raw hex. `npx astryx docs principles` lists the rules.
- Shared state lives in small stores (`src/lib/store.ts`, `useStore`), one per concern, as the Vue page kept refs.
- Extension points keep features apart: tool renderers (`src/chat/tool-renderers.ts`), thread menu actions (`src/shell/thread-actions.ts`).
- `npm run astryx -- component <Name> --dense` prints a component's props. `npm run astryx -- docs <topic>` prints the guides.
