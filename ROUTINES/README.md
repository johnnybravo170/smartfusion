# ROUTINES — Claude Code Routine prompts

Source of truth for the prompts running as Claude Code Routines at `claude.ai/code/routines`. Each markdown file here is paste-ready for the Routine "Instructions" field.

## Fleet — HeyHenry Remote routines (8)

The HeyHenry-scoped routines running at claude.ai/code/routines, all Remote (Anthropic cloud sandbox). Three Local routines visible in the same UI (`Friday memory synthesis`, `Heyhenry feature matrix refresh`, etc.) belong to **HenryOS**, not HeyHenry, and are out of scope for this registry.

| File | Slug | Cadence | What it does |
|---|---|---|---|
| `doc-writer.md` | `doc-writer` | Daily 5 AM | Engineer-audience module summaries from recent commits → `ops.knowledge_docs` + `ops.docs` |
| `weekly-dispatcher.md` | `weekly-dispatcher` | Mon 6 AM | Narrative weekly digest → worklog + knowledge |
| `ai-tools-scout.md` | `ai-tools-scout` | Daily 7 AM | AI/ML tooling scan → `ops.ideas` + email digest |
| `business-scout.md` | `business-scout` | Daily 6 AM | Strategic moves synthesis → `ops.ideas` + email |
| `helpdesk-triage.md` | `helpdesk-triage` | Daily 9 AM | Codebase-grounded diagnosis on `triage:claude` kanban cards |
| `security-probe.md` | `security-probe` | Daily 4 AM | Reviews production surfaces for security regressions → opens incidents |
| `competitive-research.md` | `competitive-research` | Daily 6 AM | Refreshes `ops.competitors` corpus with structured findings |
| `pain-points-research.md` | `pain-points-research` | Daily 7 AM | Mines contractor-community pain points → `ops.social_drafts` |

All connect to the **HeyHenry Ops MCP** at `https://ops.heyhenry.io/api/mcp`.

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

## All 8 routines now have source-of-truth in this folder. Going forward:

- The cloud config at claude.ai/code/routines is what's actually running. The repo is the place it should match.
- Drift detection is manual: when you edit a Routine in the cloud, paste the new content back into the corresponding `.md` here in the same session.
- If you find a discrepancy when reading a routine you haven't touched in a while (e.g. a copy-paste leak from a sibling routine, like the dispatcher tail that crept into pain-points-research before its capture), the repo wins — paste the repo version into the cloud to clean it.
