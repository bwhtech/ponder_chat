# Ponder Chat: pilot plan

Goal: about 30 invited pilot users on one self-hosted VM. A server restart or a deploy must not end a reply that is in progress. Features for the pilot: chat with a model selector and daily credits (done), web search, memory, Python in a sandbox, and generated UI cards.

## Decisions

| Topic | Choice | Why |
| --- | --- | --- |
| Durable runs | Workflow DevKit (`workflow` + `@ai-sdk/workflow`) with the Postgres World | It uses the Postgres we already run, so there is no new service. It has durable streams for token streaming and reconnects. `WorkflowAgent` is the AI SDK's own agent. The platform already has a spike (`platform/server/workflow/`, uncommitted). |
| Fallback | Temporal (`@temporalio/ai-sdk`) | Use it only if the spike fails its exit test. It adds a Temporal server to run, and token streaming to the browser must be built separately (Temporal has no durable streams). |
| Web search | OpenRouter's `openrouter:web_search` server tool (`openrouter.tools.webSearch()` in `@openrouter/ai-sdk-provider` 3.1) | OpenRouter runs the search. No extra API key. The cost is in the usage that OpenRouter reports, so credits charge for it with no new code. |
| Memory | Port `platform/server/memory/` (pgvector in the same Postgres) | Only personal memory: Ponder Chat has no organisation. Its gate and writer calls go to `runs`, so credits charge for them. |
| Python sandbox | Pyodide in a Deno process with no permissions, after LangChain's pyodide-sandbox. Built and tested. | No Docker, gVisor or KVM. Escape attempts (files, environment, network, subprocesses, FFI, JS globals) are refused by Deno. Only Pyodide's packages and a few vendored pure-Python ones. |
| Generated UI cards | Port `platform/web/genui/` and `server/genui.ts` without the live site queries | There is no Frappe site. A card shows the data in its own code, from the chat, a search or a Python run. |
| Hosting | One new VM. Not the dev server (its disk is 97% full and it runs the dev benches). | |

## The VM

| Item | Choice |
| --- | --- |
| Size | 8 vCPU, 16 GB RAM, 160 GB disk (for example Hetzner CPX41 or CCX33) |
| Services | Caddy (TLS), the Node server, the workflow workers, Postgres 18 with pgvector, Docker with gVisor |
| Processes | systemd units: `ponder-chat-web` (HTTP), `ponder-chat-worker` (workflow steps). Both are the same build. |
| Files | Postgres (the code already does this when no bucket is set). Move to a bucket later if the database gets large. |
| Backups | Nightly `pg_dump` to an off-site store (Hetzner Storage Box or a bucket). Keep 14 days. Test a restore once before the pilot. |
| Email | Sign-in links need a real sender: Cloudflare Email Service (the code supports it) or another provider. Set SPF and DKIM. |
| Sign-up | Invite only: an allowlist of emails. Others cannot sign in. |
| Monitoring | An uptime check on `/health`, journald logs, an alert when the disk is 80% full. |

Sandbox capacity: at most 6 sandboxes at a time, 512 MB and 1 CPU each. A sandbox with no runs for 15 minutes is removed (as now).

## Phases

1. **Durable spike: done.** Restart (SIGTERM) and crash (SIGKILL) mid-reply, Stop, reconnect in the browser, Python as a step: all pass. Not yet tested: 10 replies at once, a run waiting on the person. Move the spike into Ponder Chat, behind a flag. Exit test, on the VM size above:
   - Restart the server during a reply. The reply continues, and the open page shows it to the end.
   - Stop, Steer and the message queue work.
   - A run that waits on the person (an approval or a question, with a workflow hook) survives a restart.
   - 10 replies at the same time.
   If any item fails and cannot be fixed in the spike, switch to Temporal.
2. **Durable chat.** Replace `live-runs.ts` with workflow runs. Credits are checked when a run starts.
3. **Web search.** Add the tool, and show the sources under the reply (`Sources` from frappe-ui-ai-elements). Check that its cost appears in `runs`.
4. **Memory.** Port it, with personal scope only. Bring back the Memory page and the notes under replies.
5. **Python: done.** Pyodide sandbox, run as a workflow step; state kept in Postgres, so it survives restarts.
6. **Generated UI cards.** Port them without site queries.
7. **Production setup.** VM, Caddy, systemd, backups, email, allowlist, monitoring. A deploy script: build, migrate, restart the web and worker units.
8. **Pilot.** Invite in two groups (10, then 20). Watch cost per user per day and change the daily credits if needed.

## Risks

- The Postgres World README calls it a reference implementation and suggests separate worker processes for production. The plan runs the workers as their own systemd unit.
- A step that dies in the middle (a model call during a restart) runs again from its start. The person sees that part of the reply again, and the model call is charged twice.
- gVisor is weaker isolation than a microVM. That is acceptable for 30 known users with no secrets in the sandbox and egress limited to PyPI. For public sign-up, move to a VM with KVM (a dedicated server) and Firecracker, or to a hosted sandbox.
- Credits do not reserve cost before a reply (see README). With web search and Python, one turn can cost more. Add a per-turn step limit.

## Open decisions

- The domain, and the email sender.
- The VM provider and size.
- Daily credits for pilot users.
- Whether the Seva platform moves to the same durable runs after the pilot.
