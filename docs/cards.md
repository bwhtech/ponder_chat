# Cards in a reply

Ponder can answer with a card in the reply: headline figures, charts, a table, a list, and buttons. The chat draws the card with frappe-ui components while the model writes it.

Cards use [OpenUI](https://www.openui.com) (MIT). OpenUI Lang is a short, line-based language for UI. A model writes it instead of JSON or HTML, and a renderer draws it line by line as it streams. Ponder uses the Vue runtime, `@openuidev/vue-lang` 0.4 (OpenUI Lang 0.5).

## How it works

1. The instructions of every reply hold the card guide (`GENUI_GUIDANCE`): when to draw a card, then the reference that `library.prompt()` writes from the component library. The guide is the same for every reply, so providers cache it with the rest of the instructions. It is about 3,000 tokens.
2. The model calls `show_ui` with a title and the program:

   ```text
   root = Stack([title, kpis, chart, table])
   title = Heading("Phone plans compared")
   plans = [{plan: "Basic", price: 15, data: 5}, {plan: "Plus", price: 25, data: 20}]
   kpis = Row([NumberCard("Cheapest", @Min(plans.price), "$")])
   chart = BarChart(plans, "plan", "data", "Data per month (GB)")
   table = Table(plans, [Col("Plan", "plan"), Col("Price", "price", "currency")])
   ```

3. The page draws the card from the tool input while it streams (`web/genui/ShowUiPart.vue`).
4. The server parses the program (`server/genui/tool.ts`). One of two things then happens:
   - **Problems:** an unknown component, an argument of the wrong type, a required argument left out, a name that is used but never defined, a part that is never placed, or a `Query()` or `Mutation()`. The call fails with a list of what to fix. The page shows one line, "Could not draw …", with the list folded under it, and the model draws the card again.
   - **No problems:** the card is kept. The program is the tool call's input, so it is saved with the message and needs no table of its own. When the chat opens again, the card draws again from it.

## Data

A card has no live queries. The model writes the data into the program, from what it found in the chat (search results, pages, a Python run, a connector) or from what it knows well. The guide tells it to never make up figures, and to mark an estimate as one.

Expressions are on: `@Each`, `@Filter`, `@Sum`, `@Count`, `@Min`, `@Max`, a column of rows (`plans.price`), ternaries, and `$variables`.

## Switching views

`TabButtons` switch a card between views with no new message. They are frappe-ui's `TabButtons`, bound to a `$variable`. A click sets the variable, and every part that reads it changes:

```text
$metric = "Distance"
tabs = TabButtons(["Distance", "Pace"], $metric)
chart = $metric == "Distance" ? BarChart(runs, "day", "km") : LineChart(runs, "day", "pace")
shown = $network == "All" ? plans : @Filter(plans, "network", "==", $network)
```

The guide tells the model to use `TabButtons` to switch views, and `Buttons` for actions. A button can still `@Set` a variable. The choice is not saved: a card that opens again starts on its first view.

## Buttons

| Step | What it does |
| --- | --- |
| `@ToAssistant("…")` | Sends the message, as if the person typed it. While a reply streams, it waits in the queue. |
| No action | Sends the button's label. |
| `@OpenUrl("…")` | Opens an `http` or `https` address in a new tab. Other addresses do nothing. |
| `@Set($name, value)` | Changes a `$variable` in the card. |

Buttons are off while the card is still being written. Cards never write anywhere: a change goes back to the model as a message, and the model makes it with its own tools, which ask for approval as usual.

## Components

The components follow frappe-ui's OpenUI library ([frappe/frappe-ui#1329](https://github.com/frappe/frappe-ui/pull/1329)): the same names, the same argument order, and frappe-ui's own words for values (`theme`, `variant`, `amber`). Ponder adds `Table` and `Col`, for comparisons, and `TabButtons`, to switch views.

| Group | Components | Drawn with |
| --- | --- | --- |
| Layout | `Stack`, `Row` | Flex and grid. A `Row` wraps on a phone. |
| Content | `Heading`, `Text`, `Badge`, `Alert` | frappe-ui `Badge` and `Alert` |
| Actions | `Button`, `Buttons`, `TabButtons` | frappe-ui `Button`, `TabButtons` |
| Data | `NumberCard`, `BarChart`, `LineChart`, `DonutChart` | `frappe-ui/charts` |
| Data | `List`, `ListRow`, `Table`, `Col` | `frappe-ui/list` |

Charts, lists and tables sit in the bordered box of /admin's dashboard, with its label colours (`data-slot="dashboard"`, `web/base.css`). Numbers come from `web/numbers.ts`, and dates from `web/dates.ts`.

There are no inputs or forms yet, so the guide leaves out OpenUI's sections on forms.

## Files

| File | Job |
| --- | --- |
| `shared/genui.ts` | The component library (schemas only), the prompt rules and examples. The server and the page use the same definition. |
| `server/genui/tool.ts` | `show_ui`, its check, and the guide in the instructions. |
| `web/genui/components.ts` | One frappe-ui renderer for each component. |
| `web/genui/GenuiCard.vue` | The OpenUI `Renderer`, and what buttons do. Its own chunk, with the OpenUI runtime and the charts (about 245 KB gzip). A chat with no cards never loads it. |
| `web/genui/ShowUiPart.vue` | A `show_ui` call in a reply: the card, or one line when the check failed. |
| `web/genui/actions.ts` | How a card sends a message (`provideCardSend` in `web/ToolContext.vue`). |

To add a component: define it in `shared/genui.ts`, add its renderer to `RENDERERS` in `web/genui/components.ts`, and run `npx vitest run server/genui`. The test checks that every example in the guide still passes the server's check.

## Limits

- No live data. A card shows what the model wrote when it drew it.
- The chat's first stylesheet includes the classes of frappe-ui's charts and lists, about 0.3 KB more gzip.
- OpenUI Lang 1.0 is in the React runtime only. Ponder stays on 0.5 until the Vue runtime has 1.0.
- When frappe-ui ships its OpenUI library, the renderers can come from `frappe-ui/experimental/openui`. Programs saved in chats keep drawing, because the names and the argument order are the same.
