/**
 * Conditionally register MCP tool modules based on the API key's scopes.
 *
 * Each module is registered if the key has ANY of its scopes. Per-tool
 * scope enforcement still happens inside `withAudit` — this just hides
 * tools the key has no business calling at all so they do not clutter
 * `tools/list`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgentTools } from './agents';
import { registerCompetitorTools } from './competitors';
import type { McpToolCtx } from './context';
import { registerDecisionTools } from './decisions';
import { registerDocsTools } from './docs';
import { registerEmailTools } from './email';
import { registerEscalateTools } from './escalate';
import { registerHelpDocsTools } from './help_docs';
import { registerIdeaTools } from './ideas';
import { registerIncidentTools } from './incidents';
import { registerKanbanTools } from './kanban';
import { registerKnowledgeTools } from './knowledge';
import { registerMetaTools } from './meta';
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
  if (any(ctx.scopes, 'read:help_docs', 'write:help_docs', 'admin:help_docs')) {
    registerHelpDocsTools(server, ctx);
  }
  if (any(ctx.scopes, 'read:agents', 'write:agents:run', 'admin:agents')) {
    registerAgentTools(server, ctx);
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
  if (any(ctx.scopes, 'write:email')) {
    registerEmailTools(server, ctx);
  }

  // Meta tools (memory guide + cross-surface lookup + activity digest).
  // Registered for any caller with at least one read scope so that
  // `ops_memory_guide` is always callable and the cross-surface aggregators
  // can see whatever the token has access to. Individual surface access is
  // still gated inside the handlers.
  registerMetaTools(server, ctx);
}
