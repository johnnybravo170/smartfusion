#!/usr/bin/env node
/**
 * @heyhenry/mcp-ops — MCP server (stdio) wrapping the HeyHenry Ops HTTP API.
 *
 * Background Claude Code Routines load this as a connector. Each routine ships
 * with its own scoped OPS_API_KEY so a research agent cannot, for example,
 * write to the roadmap.
 *
 * Required env:
 *   OPS_API_KEY        — `ops_<id>_<secret>` (or split via OPS_API_KEY_ID/SECRET)
 *   OPS_ACTOR_NAME     — short slug for the agent, e.g. "competitive-research"
 *
 * Optional env:
 *   OPS_BASE_URL       — defaults to https://ops.heyhenry.io
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerBoardTools } from './tools/board.js';
import { registerCompetitorTools } from './tools/competitors.js';
import { registerDecisionTools } from './tools/decisions.js';
import { registerDocsTools } from './tools/docs.js';
import { registerIdeasTools } from './tools/ideas.js';
import { registerIncidentTools } from './tools/incidents.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerReviewQueueTools } from './tools/review_queue.js';
import { registerRoadmapTools } from './tools/roadmap.js';
import { registerSocialDraftTools } from './tools/social_drafts.js';
import { registerWorklogTools } from './tools/worklog.js';

// Fail fast if the key isn't present so the agent gets a useful error at
// connector startup instead of on first tool call.
if (!process.env.OPS_API_KEY && !(process.env.OPS_API_KEY_ID && process.env.OPS_API_KEY_SECRET)) {
  process.stderr.write('mcp-ops: missing OPS_API_KEY (or OPS_API_KEY_ID + OPS_API_KEY_SECRET).\n');
  process.exit(1);
}
if (!process.env.OPS_ACTOR_NAME) {
  process.stderr.write(
    'mcp-ops: warning — OPS_ACTOR_NAME not set; defaulting actor_name to "mcp-ops".\n',
  );
}

const server = new McpServer({
  name: 'heyhenry-ops',
  version: '0.1.0',
});

registerCompetitorTools(server);
registerIncidentTools(server);
registerSocialDraftTools(server);
registerDocsTools(server);
registerWorklogTools(server);
registerKnowledgeTools(server);
registerRoadmapTools(server);
registerIdeasTools(server);
registerDecisionTools(server);
registerReviewQueueTools(server);
registerBoardTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
