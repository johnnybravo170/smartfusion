# HeyHenry MCP Server

Standalone MCP (Model Context Protocol) server that connects Claude Desktop (or any MCP-compatible client) to a tenant's live HeyHenry business data. Operators can query customers, jobs, quotes, invoices, todos, and work log conversationally.

## Prerequisites

- Node.js 20+
- pnpm

## Setup

```bash
cd mcp
pnpm install
```

## Claude Desktop Configuration

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "heyhenry": {
      "command": "npx",
      "args": ["tsx", "/path/to/heyhenry/mcp/src/index.ts"],
      "env": {
        "HEYHENRY_TENANT_ID": "your-tenant-uuid",
        "HEYHENRY_DATABASE_URL": "postgres://postgres.ref:password@aws-1-ca-central-1.pooler.supabase.com:5432/postgres"
      }
    }
  }
}
```

Replace `/path/to/heyhenry` with the actual path on your machine, and fill in the tenant UUID and database URL. (Old `SMARTFUSION_*` env names still work as fall-backs.)

## Available Tools

| Tool | Description | Parameters |
|------|-------------|------------|
| `get_dashboard` | Today's snapshot: quotes, jobs, invoices, revenue | None |
| `list_customers` | List/search customers | `search?`, `type?`, `limit?` |
| `get_customer` | Full customer detail with related counts | `id` |
| `create_customer` | Add a new customer | `name`, `type`, `email?`, `phone?`, `city?`, `notes?` |
| `list_quotes` | List quotes with totals and surfaces | `status?`, `customer_id?`, `limit?` |
| `get_quote` | Quote detail with surfaces breakdown | `id` |
| `list_jobs` | List jobs with status and scheduling | `status?`, `customer_id?`, `limit?` |
| `get_job` | Job detail with links and worklog | `id` |
| `update_job_status` | Change job status + log to worklog | `id`, `status` |
| `list_invoices` | List invoices with amounts | `status?`, `limit?` |
| `get_revenue_summary` | Revenue and outstanding totals | `period?` |
| `list_todos` | List todos | `done?`, `limit?` |
| `create_todo` | Create a todo | `title`, `due_date?` |
| `complete_todo` | Mark a todo as done | `id` |
| `search_worklog` | Full-text search worklog entries | `query`, `limit?` |
| `add_worklog_note` | Add a note to the work log | `title`, `body?` |
| `list_catalog` | Service catalog with pricing | None |

## Example Conversations

- "What jobs do I have scheduled this week?"
- "Add a customer named Mike Thompson, commercial, phone 604-555-9876"
- "What's my revenue this month?"
- "Note: The Clearbrook lot needs a site visit, back gate only"
- "What did I charge the Patels last time?"
- "Mark the Johnson job as complete"
- "Show me all unpaid invoices"
- "What do I charge for driveways?"

## Development

```bash
# Typecheck
npx tsc --noEmit

# Run test suite (needs env vars)
SMARTFUSION_TENANT_ID=... SMARTFUSION_DATABASE_URL=... pnpm test

# Manual test via stdin
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | \
  SMARTFUSION_TENANT_ID=... SMARTFUSION_DATABASE_URL=... npx tsx src/index.ts
```
