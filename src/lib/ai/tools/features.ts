/**
 * Feature lookup tool — answers "where is X?" / "can I do X here?" by
 * searching the static feature catalog. Phase 2 swaps the body for an
 * embedding search over `public.help_docs`; the tool surface stays the same.
 */

import { searchFeatures } from '../feature-catalog';
import type { AiTool } from '../types';

export const featureTools: AiTool[] = [
  {
    definition: {
      name: 'find_feature',
      description:
        'Find which page in HeyHenry handles a given concept or workflow. Use this when the operator asks "where is X?", "how do I X?", "can I do X?", or "does HeyHenry support X?". Returns matching pages with their path and a one-line summary so you can answer with a concrete location and what the page does. Do NOT use this for the operator\'s data (that\'s what list_* / get_* tools are for) — only for HeyHenry feature/page lookup.',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'Free-text query — what the operator is trying to do. Example: "send a referral", "track gst", "import receipts".',
          },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      const query = typeof input.query === 'string' ? input.query : '';
      if (!query.trim()) return 'No query provided.';

      const matches = searchFeatures(query, 5);
      if (matches.length === 0) {
        return `No matching feature found for "${query}". HeyHenry may not support this directly — say so plainly rather than guessing.`;
      }

      const lines = matches.map((m) => `- ${m.name} (${m.path}) — ${m.summary}`);
      return `Feature matches for "${query}":\n${lines.join('\n')}`;
    },
  },
];
