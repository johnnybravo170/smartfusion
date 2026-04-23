/**
 * Remote MCP server endpoint for Claude Code Routines (and any other
 * Streamable-HTTP MCP client).
 *
 * Auth: OAuth 2.1 bearer token issued via /authorize + /token. The opaque
 * access token is looked up by sha256 in `ops.oauth_tokens`. Per-tool scope
 * checks happen inside the tool handler via `withAudit`.
 *
 * On 401 we attach `WWW-Authenticate: Bearer resource_metadata="..."` so
 * the client can discover the auth server (RFC 9728 / MCP auth spec).
 *
 * Stateless mode: each POST is independent. We construct a fresh McpServer,
 * register only the tools the token's scopes allow, then hand the request
 * to the SDK's web-standard transport.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { authenticateOAuthToken } from '@/lib/api-auth';
import { registerScopedTools } from '@/server/mcp-tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const auth = await authenticateOAuthToken(req);
  if (!auth.ok) return auth.response;

  const server = new McpServer(
    { name: 'heyhenry-ops', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  // keyId is null because OAuth tokens live in ops.oauth_tokens, not
  // ops.api_keys (which is what audit_log.key_id FKs to). actorName carries
  // the client_id (Anthropic Routine name) instead.
  registerScopedTools(server, {
    keyId: null,
    actorName: auth.token.client_id,
    scopes: auth.token.scopes,
  });

  // Stateless transport — no session IDs. enableJsonResponse=true returns
  // a single JSON response per request instead of an SSE stream, which is
  // what Routines (one-shot, no streaming UI) expects.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}
