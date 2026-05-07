# ROUTINES — Claude Code Routine prompts

Source of truth for the prompts running as Claude Code Routines at `claude.ai/code/routines`. Each markdown file here is paste-ready for the Routine "Instructions" field.

## Fleet (10 routines)

The actual list at claude.ai/code/routines as of 2026-05-06. Five have prompts in this repo; five are listed without prompts (TODO: paste them in next time you edit them in the cloud).

### Remote (run in Anthropic cloud)

| File | Slug | Cadence | What it does |
|---|---|---|---|
| `doc-writer.md` | `doc-writer` | Daily 5 AM | Engineer-audience module summaries from recent commits → `ops.knowledge_docs` + `ops.docs` |
| `weekly-dispatcher.md` | `weekly-dispatcher` | Mon 6 AM | Narrative weekly digest → worklog + knowledge |
| `ai-tools-scout.md` | `ai-tools-scout` | Daily 7 AM | AI/ML tooling scan → `ops.ideas` + email digest |
| `business-scout.md` | `business-scout` | Daily 6 AM | Strategic moves synthesis → `ops.ideas` + email |
| `helpdesk-triage.md` | `helpdesk-triage` | Daily 9 AM | Codebase-grounded diagnosis on `triage:claude` kanban cards |
| _(no file)_ | `pain-points-research` | Daily 7 AM | Scrapes contractor-community sources → `social_drafts` + `ideas` |
| _(no file)_ | `security-probe` | Daily 4 AM | Reviews recent changes for security issues → opens incidents |
| _(no file)_ | `competitive-research` | Daily 6 AM | Refreshes `ops.competitors` corpus |

### Local (run on Jonathan's machine via Claude Code CLI)

| File | Slug | Cadence | What it does |
|---|---|---|---|
| _(no file)_ | `friday-memory-synthesis` | Fri 5 PM | Compresses week into a memory note that persists across CC sessions |
| _(no file)_ | `feature-matrix-refresh` | Daily 6 AM | Re-derives the public feature matrix (HeyHenry vs competitors) |

All connect to the **HeyHenry Ops MCP** at `https://ops.heyhenry.io/api/mcp` (except possibly the Local ones, which may run unscoped on the local repo).

## When you change a prompt

1. Edit the markdown here in the repo (source of truth).
2. Paste the updated content into the Routine's Instructions field at `claude.ai/code/routines`.
3. Run once manually to verify; check `ops.heyhenry.io/agents/<slug>` for the new run row.

The repo and the cloud config can drift if step 2 is forgotten — that's the trade-off. If you find them out of sync, the cloud version is what's actually running; copy that back to the repo and figure out why someone changed only one side.

## Required boilerplate

Every routine prompt opens + closes an `ops.agent_runs` row so it surfaces on the agents dashboard:

- **Step 0** (top of prompt): call `agent_run_start({ slug, trigger })`. Save `run_id`.
- **Final step**: call `agent_run_finish({ run_id, outcome, summary, items_scanned?, items_acted?, payload? })`.

`outcome` enums: `"success"` | `"skipped"` (ran but had nothing to do) | `"failure"` (crashed).

If `agent_run_start` fails, log it but continue — instrumentation must never gate the actual work.

## Rules of thumb for picking Routine vs Vercel cron

- **Routine** when: small reasoning loops, MCP tool calls, narrative output, codebase reading (the sandbox mounts the repo).
- **Vercel cron** when: pre-filter many items, fan-out DB writes, embeddings, multi-API orchestration, fires more than 15×/day (Anthropic Max plan cap).
- **Managed Agent** when: synchronous in-request, unpredictable bursty volume.

In-repo crons live under `ops/src/app/api/ops/<name>/run/route.ts` and use `ops/src/lib/agents/{recordAgentRun, finishAgentRun, withAgentRun}` instead of the MCP tools.

## TODO — capture missing prompts

`pain-points-research`, `security-probe`, `competitive-research`, `friday-memory-synthesis`, and `feature-matrix-refresh` exist in claude.ai but have no source-of-truth markdown here. Next time you edit any of them in the cloud UI, paste the new content into a same-named file in this directory so we don't lose history when the cloud config rotates.
