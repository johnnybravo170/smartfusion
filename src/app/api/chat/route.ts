/**
 * POST /api/chat — Streaming AI chat endpoint.
 *
 * Accepts a conversation history, calls Claude with business tools,
 * and streams newline-delimited JSON back to the client.
 *
 * Stream event types:
 *   {"type":"text","content":"..."}
 *   {"type":"tool_start","name":"..."}
 *   {"type":"tool_end","name":"..."}
 *   {"type":"done"}
 *   {"type":"error","message":"..."}
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSystemPrompt } from '@/lib/ai/system-prompt';
import { executeToolCall, getToolDefinitions, setToolTimezone } from '@/lib/ai/tools';
import { getCurrentTenant } from '@/lib/auth/helpers';

// ---------------------------------------------------------------------------
// Lazy-init Anthropic client (same pattern as Stripe/Resend)
// ---------------------------------------------------------------------------

let _client: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

type StreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_start'; name: string }
  | { type: 'tool_end'; name: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  // 1. Authenticate
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. Parse and validate body
  let body: { messages?: unknown; threadId?: string };
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages must be a non-empty array' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const messages = body.messages as ChatMessage[];

  // Validate message shape
  for (const msg of messages) {
    if (!msg.role || !['user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string') {
      return new Response(
        JSON.stringify({
          error: 'Each message must have role (user|assistant) and content (string)',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // 3. Set up tools with tenant timezone
  setToolTimezone(tenant.timezone);
  const systemPrompt = getSystemPrompt(tenant.name, tenant.timezone, tenant.vertical);
  const toolDefinitions = getToolDefinitions(tenant.vertical);
  const model = process.env.CHAT_MODEL || 'claude-sonnet-4-6';

  // 4. Create streaming response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event: StreamEvent) {
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      }

      try {
        const client = getAnthropicClient();

        // Convert our simple messages to Anthropic format
        let anthropicMessages: Anthropic.MessageParam[] = messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));

        // Tool call loop: Claude may request tools, we execute and continue
        let continueLoop = true;
        while (continueLoop) {
          continueLoop = false;

          const response = client.messages.stream({
            model,
            max_tokens: 4096,
            system: systemPrompt,
            messages: anthropicMessages,
            tools: toolDefinitions as Anthropic.Tool[],
          });

          // Collect the full response to check for tool_use
          let fullText = '';
          const toolUseBlocks: Array<{
            id: string;
            name: string;
            input: Record<string, unknown>;
          }> = [];

          // Stream text content as it arrives
          response.on('text', (text) => {
            fullText += text;
            send({ type: 'text', content: text });
          });

          // Wait for the stream to complete
          const finalMessage = await response.finalMessage();

          // Check for tool use blocks in the response
          for (const block of finalMessage.content) {
            if (block.type === 'tool_use') {
              toolUseBlocks.push({
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
              });
            }
          }

          // If there are tool calls, execute them and continue
          if (toolUseBlocks.length > 0) {
            // Build the assistant message content (text + tool_use blocks)
            const assistantContent: Anthropic.ContentBlockParam[] = [];
            if (fullText) {
              assistantContent.push({ type: 'text', text: fullText });
            }
            for (const tb of toolUseBlocks) {
              assistantContent.push({
                type: 'tool_use',
                id: tb.id,
                name: tb.name,
                input: tb.input,
              });
            }

            // Execute each tool and build tool_result messages
            const toolResults: Anthropic.ToolResultBlockParam[] = [];
            for (const tb of toolUseBlocks) {
              send({ type: 'tool_start', name: tb.name });
              const result = await executeToolCall(tb.name, tb.input);
              send({ type: 'tool_end', name: tb.name });
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tb.id,
                content: result,
              });
            }

            // Append assistant message and tool results to the conversation
            anthropicMessages = [
              ...anthropicMessages,
              { role: 'assistant', content: assistantContent },
              { role: 'user', content: toolResults },
            ];

            // Continue the loop so Claude can process tool results
            continueLoop = true;
          }
        }

        send({ type: 'done' });
      } catch (e) {
        const message = e instanceof Error ? e.message : 'An unexpected error occurred';
        send({ type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
