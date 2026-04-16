# Architecture Decisions Log

## 2026-04-15

Stack: Next.js 15 App Router, Supabase (ca-central-1), Drizzle ORM, shadcn/ui + Tailwind v4, Biome, pnpm, Vitest + Playwright. Confirmed by Jonathan 2026-04-15.

## 2026-04-15 — `quote_surfaces` inherited-tenant pattern

`quote_surfaces` deliberately does NOT carry a `tenant_id` column. Tenant is inherited through `quote_id -> quotes.tenant_id`, and the RLS policy in `0016_all_rls_policies.sql` uses a subquery through `quotes` to enforce isolation.

Rationale: `tenant_id` on a child table is redundant when the parent FK is NOT NULL + ON DELETE CASCADE. Storing it twice creates a consistency problem (what if they disagree?) and a write-path footgun (client might fabricate a tenant_id that doesn't match the quote). The cost is a slightly more expensive RLS check, mitigated by the FK index on `quote_surfaces.quote_id`.

Applied only to `quote_surfaces` for Phase 1. Other child tables (`photos`, `quote_surfaces`'s sibling tables, etc.) keep their own `tenant_id` because they are queried directly more often.
