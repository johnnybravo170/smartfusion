/**
 * OpenAI Realtime tool adapters.
 *
 * Our tool definitions (in src/lib/ai/tools) use Anthropic's JSON-Schema
 * shape. OpenAI Realtime expects a slightly different wrapper:
 *
 *   { type: 'function', name, description, parameters: <JSON Schema> }
 *
 * Properties / required / descriptions transfer as-is — both providers
 * accept standard JSON Schema. No type-case transformation needed
 * (unlike Gemini, which wanted uppercase TYPE names).
 *
 * `clientFunctionDeclarations` are the screen-awareness tools that execute
 * in the browser (form fill/submit) rather than through /api/henry/tool.
 * The names here must match the client-side dispatch in use-henry.ts.
 */

import type { AiTool } from '@/lib/ai/types';

export type OpenAIRealtimeTool = {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

export const CLIENT_TOOL_NAMES = new Set([
  'get_current_screen_context',
  'fill_current_form',
  'submit_current_form',
]);

export function toOpenAIRealtimeTools(tools: AiTool[]): OpenAIRealtimeTool[] {
  return tools.map((t) => ({
    type: 'function' as const,
    name: t.definition.name,
    description: t.definition.description,
    parameters: t.definition.input_schema as OpenAIRealtimeTool['parameters'],
  }));
}

export const clientRealtimeTools: OpenAIRealtimeTool[] = [
  {
    type: 'function',
    name: 'get_current_screen_context',
    description:
      'Inspect what the operator is currently looking at. Returns the current URL route and, when a form is visible, the form schema (title, field names/labels/types/options, and current values). Call this FIRST whenever the operator says anything that sounds like data entry ("their name is...", "add the phone number...", "put the email as...") so you know which fields exist and what they already contain.',
    parameters: { type: 'object', properties: {} },
  },
  {
    type: 'function',
    name: 'fill_current_form',
    description:
      'Populate one or more fields in the form the operator is currently viewing. Use the exact field names returned by get_current_screen_context. The operator will review and submit — do NOT call create_customer/create_job/etc. when the user is on the corresponding form page; fill the form instead.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description:
            'Fields to update. Each entry has a name (from the form schema) and a value.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Field machine name from the schema.' },
              value: { type: 'string', description: 'New value for the field, as a string.' },
            },
            required: ['name', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    type: 'function',
    name: 'submit_current_form',
    description:
      'Submit the form the operator is currently viewing. Only call this after confirming with the operator. Some forms may not support programmatic submit; in that case tell the operator to tap the submit button themselves.',
    parameters: { type: 'object', properties: {} },
  },
];
