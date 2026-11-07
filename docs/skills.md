# Skills

A skill is a name, a description and Markdown instructions that an admin writes on `/admin/skills`. A skill that is on works for everyone. There are two kinds:

- **Automatic.** Ponder sees the skill's name and description in every reply's instructions. When the description fits the message, it loads the skill with the `use_skill` tool and follows it.
- **When asked.** The frontmatter has `disable-model-invocation: true`. Ponder does not see the skill until a person asks for it.

A person can start any skill that is on: they type `$name` anywhere in a message, or `/name` at the start. The skill then shows as a chip in the message box.

## Writing a skill

"New skill" asks for a name and a description, both required. The skill then opens in the editor, off. The instructions go in the code editor (Markdown); the name, the description and the two switches sit beside it. A skill can be turned on only when it has instructions.

A whole `SKILL.md` pasted into the instructions fills in the name, the description and the kind from its frontmatter, and keeps the rest as the instructions.

## The file

The server keeps each skill as one Agent Skills file (`SKILL.md`) in the `source` column, and writes the frontmatter itself. "Download SKILL.md" gives the saved file.

```markdown
---
name: meeting-notes
description: Turn a meeting transcript into decisions, owners and dates.
disable-model-invocation: true
---

# Meeting notes
...
```

| Key | Rule |
| --- | --- |
| `name` | Lowercase letters, numbers and hyphens; at most 64 characters. Unique among skills that are not deleted. |
| `description` | Required; one line, at most 300 characters. Every automatic skill's description is in every reply's instructions, so keep it short. |
| `disable-model-invocation` | `true` for a skill that runs only when asked. Leave it out for an automatic skill. |

The body is the instructions, at most 20,000 characters. `shared/skill-file.ts` checks a skill, writes the file and reads it back; the server and the editor use the same checks.

## Files

| File | Job |
| --- | --- |
| `shared/skill-file.ts` | Checks a skill. Writes it as a `SKILL.md` file, and reads one back. |
| `server/skills.ts` | The `skills` table, and saving, listing and deleting skills. |
| `server/admin/routes.ts` | `/api/admin/skills`: list, read, create, save, on/off, delete. |
| `server/workflow/skills.ts` | A reply's skills: the step, the instructions section, `use_skill`, and the `<skill>` text for a skill the person asked for. |
| `web/skills/` | The `$` menu, the chips, and the `use_skill` line in a reply. |
| `web/admin/pages/Skills.vue`, `SkillEdit.vue`, `components/NewSkillDialog.vue` | The admin list, the editor and the New skill dialog. The instructions are in frappe-ui's `CodeEditor`, with Markdown. |

## How a reply uses skills

1. `skillsStep` reads the skills that are on. The workflow records the result, so a replayed run uses the same skills, even if an admin changed one since.
2. `skillsGuidance` adds a section to the instructions. It lists the automatic skills, and tells the model what a `<skill>` block in a message means.
3. `use_skill` is in the tools when at least one automatic skill is on. Its `name` is an enum of the automatic skills, so the model cannot load a "when asked" skill.
4. A skill that the person asked for is a `data-skill` part on their message: `{ type: "data-skill", data: { name } }`. `loadModelMessages` replaces the part with the skill's instructions in a `<skill>` block, on this turn and on later ones, so a follow-up still has them. A skill that is off or deleted becomes a short note, and the model says that it could not use it.

## Saving

- A save sends the `updatedAt` that the editor loaded. If someone saved the skill after that, the server refuses the save with 409, so it does not overwrite their change.
- A deleted skill keeps its row, with `deleted_at`. Its name is free for a new skill.
- The server keeps the skills for 5 seconds. A change shows at once in the server process that made it.

## Compared with the AI SDK

The AI SDK's [Add Skills to Your Agent](https://ai-sdk.dev/cookbook/guides/agent-skills) guide does the same in its own words: the system prompt lists each skill's name and description, and a `loadSkill` tool returns the instructions when a task needs them ("progressive disclosure"). Ponder differs in three ways:

- Skills live in Postgres, not in folders, so admins can edit them on `/admin`.
- `use_skill` takes only the names of automatic skills (an enum), so the model can't load a "when asked" skill.
- A person can start a skill with `$name`. The guide has no such path.

The AI SDK's other skill features are for other cases: `uploadSkill` sends a skill to Anthropic's code-execution containers, and `HarnessAgent` passes skills to coding-agent harnesses such as Claude Code. Neither applies to a chat on OpenRouter models.
