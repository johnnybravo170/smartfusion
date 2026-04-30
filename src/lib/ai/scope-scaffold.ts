/**
 * AI-assisted scope scaffold generation.
 *
 * Operator types (or speaks) a brief description of a renovation
 * project; Henry returns a structured scaffold of buckets + line
 * items grouped by section. **Structure only — no prices.** Per the
 * rollup walk-back, AI auto-pricing erodes trust because prices drift.
 *
 * Returns null on any AI failure — caller falls back to "Start from
 * a starter template" or manual authoring. Suggestions, not commands.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { StarterTemplate } from '@/data/starter-templates/types';

export type ScaffoldDetailLevel = 'quick' | 'standard' | 'detailed';

export type ScopeScaffoldInput = {
  /** Operator's free-form description. Voice-transcript-friendly. */
  description: string;
  /** Quick/Standard/Detailed — drives target line count per section. */
  detailLevel: ScaffoldDetailLevel;
  /** Optional contractor context — vertical, region, prior templates etc. */
  vertical?: string;
};

const SYSTEM_PROMPT = `You are Henry, an AI assistant for a residential renovation contractor. The contractor describes a job in plain language; you return a structured scaffold of buckets (sections of work) and line items inside each bucket.

Return ONLY valid JSON matching this shape:

{
  "label": "string",           // short title for the scaffold ("Bathroom reno — 5x8")
  "description": "string",     // 1-2 sentences summarizing the scope
  "buckets": [
    {
      "name": "string",        // bucket name (e.g. "Plumbing Rough", "Tile", "Cabinets")
      "section": "interior" | "exterior" | "general",
      "description": "string?",
      "lines": [
        {
          "label": "string",   // specific scope item ("Move drain & supply for vanity")
          "category": "material" | "labour" | "sub" | "equipment" | "overhead",
          "qty": number,       // quantity (whole or decimal)
          "unit": "string",    // unit ("ea", "lot", "sqft", "lf", "hr")
          "notes": "string?"   // optional clarification
        }
      ]
    }
  ]
}

Rules:
- NO prices. No \`unit_price_cents\`, no \`unit_cost_cents\`, no dollar values anywhere. Structure only.
- Use the contractor's category vocabulary: material / labour / sub / equipment / overhead. Default to material when unsure.
- Line counts vary by detail level:
   - "quick": ~5 line items total across 3-4 buckets — top-level scope only
   - "standard": ~15 line items across 5-7 buckets — typical breakdown
   - "detailed": ~40+ line items across 8-10 buckets — every cost broken out
- Group related work into buckets matching how a renovation contractor would estimate (Demo, Plumbing, Electrical, Drywall, etc.).
- Use lot, ea, sqft, lf, hr as units. Avoid abstract units like "each scope" or "project".
- If the description is too vague to scaffold (e.g. "fix the house"), return buckets: [] with a label/description explaining what info you need.
- Don't fabricate scope. If the operator only mentions plumbing, don't add framing or paint.
- Output ONLY the JSON. No prose, no markdown fences.`;

const MODEL = process.env.SCOPE_SCAFFOLD_MODEL ?? 'claude-sonnet-4-6';

const TARGET_LINE_COUNTS: Record<ScaffoldDetailLevel, string> = {
  quick: '~5 total line items across 3-4 buckets',
  standard: '~15 total line items across 5-7 buckets',
  detailed: '~40+ total line items across 8-10 buckets',
};

export async function generateScopeScaffold(
  input: ScopeScaffoldInput,
  client?: Anthropic,
): Promise<StarterTemplate | null> {
  const description = (input.description ?? '').trim();
  if (description.length < 10) return null;

  const anthropic = client ?? new Anthropic();

  const userPrompt = [
    `Detail level: ${input.detailLevel} (${TARGET_LINE_COUNTS[input.detailLevel]})`,
    input.vertical ? `Vertical: ${input.vertical}` : null,
    '',
    'Job description:',
    description,
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });

    const text = res.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
    if (!text) return null;

    // Strip any accidental markdown fences just in case.
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as StarterTemplate;
    if (!parsed || !Array.isArray(parsed.buckets)) return null;
    // Force-strip any prices the model snuck in despite the system prompt.
    const sanitized: StarterTemplate = {
      slug: parsed.slug ?? '',
      label: parsed.label ?? 'Scaffold',
      description: parsed.description ?? '',
      buckets: parsed.buckets.map((b) => ({
        name: b.name,
        section: ['interior', 'exterior', 'general'].includes(b.section) ? b.section : 'interior',
        description: b.description,
        lines: (b.lines ?? []).map((l) => ({
          label: l.label,
          category: ['material', 'labour', 'sub', 'equipment', 'overhead'].includes(l.category)
            ? l.category
            : 'material',
          qty: typeof l.qty === 'number' && l.qty > 0 ? l.qty : 1,
          unit: l.unit ?? 'lot',
          notes: l.notes,
        })),
      })),
    };
    return sanitized;
  } catch (err) {
    console.warn('generateScopeScaffold failed:', err);
    return null;
  }
}
