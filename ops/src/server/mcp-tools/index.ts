/**
 * Conditionally register MCP tool modules based on the API key's scopes.
 *
 * Each module is registered if the key has ANY of its scopes. Per-tool
 * scope enforcement still happens inside `withAudit` — this just hides
 * tools the key has no business calling at all so they do not clutter
 * `tools/list`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCompetitorTools } from './competitors';
import type { McpToolCtx } from './context';
import { registerDecisionTools } from './decisions';
import { registerDocsTools } from './docs';
import { registerEscalateTools } from './escalate';
import { registerIdeaTools } from './ideas';
import { registerIncidentTools } from './incidents';
import { registerKanbanTools } from './kanban';
import { registerKnowledgeTools } from './knowledge';
import { registerReviewQueueTools } from './review_queue';
import { registerRoadmapTools } from './roadmap';
import { registerSocialDraftTools } from './social_drafts';
import { registerWorklogTools } from './worklog';

function any(scopes: string[], ...required: string[]): boolean {
  return required.some((r) => scopes.includes(r));
}

export function registerScopedTools(server: McpServer, ctx: McpToolCtx) {
  if (any(ctx.scopes, 'read:competitors', 'write:competitors')) {
    registerCompetitorTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:incidents', 'write:incidents')) {
    registerIncidentTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:social', 'write:social')) {
    registerSocialDraftTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:docs', 'write:docs')) {
    registerDocsTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:knowledge', 'write:knowledge')) {
    registerKnowledgeTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:worklog', 'write:worklog')) {
    registerWorklogTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:roadmap', 'write:roadmap')) {
    registerRoadmapTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:ideas', 'write:ideas')) {
    registerIdeaTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:decisions', 'write:decisions')) {
    registerDecisionTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:review_queue')) {
    registerReviewQueueTools(server, ctx);
  }
  if (any(ctx.scopes, 'write:escalate')) {
    registerEscalateTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:kanban', 'write:kanban')) {
    registerKanbanTools(server, ctx);
  }
}
