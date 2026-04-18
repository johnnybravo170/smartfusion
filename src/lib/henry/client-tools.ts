/**
 * Client-side tools for Henry.
 *
 * These tool declarations are sent to Gemini alongside the server-side tool
 * declarations, but when Gemini invokes one, the client runs the handler
 * locally (no /api/henry/tool round-trip) because the handler needs access
 * to React state — specifically the screen context registry.
 *
 * The names here must match the client-side dispatch in use-henry.ts.
 */

import type { GeminiFunctionDeclaration } from '@/lib/henry/adapter';

export const CLIENT_TOOL_NAMES = new Set([
  'get_current_screen_context',
  'fill_current_form',
  'submit_current_form',
]);

export const clientFunctionDeclarations: GeminiFunctionDeclaration[] = [
  {
    name: 'get_current_screen_context',
    description:
      'Inspect what the operator is currently looking at. Returns the current URL route and, when a form is visible, the form schema (title, field names/labels/types/options, and current values). Call this FIRST whenever the operator says anything that sounds like data entry ("their name is...", "add the phone number...", "put the email as...") so you know which fields exist and what they already contain.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
  {
    name: 'fill_current_form',
    description:
      'Populate one or more fields in the form the operator is currently viewing. Use the exact field names returned by get_current_screen_context. The operator will review and submit — do NOT call create_customer/create_job/etc. when the user is on the corresponding form page; fill the form instead.',
    parameters: {
      type: 'OBJECT',
      properties: {
        fields: {
          type: 'ARRAY',
          description:
            'Fields to update. Each entry has a name (from the form schema) and a value.',
          items: {
            type: 'OBJECT',
            properties: {
              name: { type: 'STRING', description: 'Field machine name from the schema.' },
              value: { type: 'STRING', description: 'New value for the field, as a string.' },
            },
            required: ['name', 'value'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'submit_current_form',
    description:
      'Submit the form the operator is currently viewing. Only call this after confirming with the operator. Some forms may not support programmatic submit; in that case tell the operator to tap the submit button themselves.',
    parameters: {
      type: 'OBJECT',
      properties: {},
    },
  },
];
