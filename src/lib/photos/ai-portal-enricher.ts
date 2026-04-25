/**
 * Henry's portal-aware photo enricher.
 *
 * Sister to ai-classifier.ts (which assigns the internal `tag` column
 * + operator caption). This one looks at the same image with a
 * homeowner-portal lens and returns:
 *   - portal_tags: subset of [before, progress, behind_wall, issue,
 *     completion, marketing] — multi-valued because a single photo can
 *     legitimately be both "behind_wall" and "completion"
 *   - portal_caption: a calm, factual, homeowner-friendly sentence
 *     ("we ran the new gas line and added blocking for the floating
 *     shelves before drywall closed up") instead of the operator-voice
 *     caption ("ran 1/2" black iron, blocked for shelves").
 *
 * Uses Claude Haiku (fast + cheap) — same model as the internal
 * classifier — via the Anthropic SDK. JSON-only output enforced via
 * prompt + parser.
 */

import Anthropic from '@anthropic-ai/sdk';
import { PORTAL_PHOTO_TAGS, type PortalPhotoTag } from '@/lib/validators/portal-photo';

const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export type PortalEnrichmentResult = {
  portalTags: PortalPhotoTag[];
  portalCaption: string;
};

const PORTAL_ENRICHER_SYSTEM_PROMPT = `You are Henry, an AI assistant for a residential renovation contractor. You're looking at one job-site photo and labelling it for the HOMEOWNER's portal — NOT for internal contractor documentation.

Return ONLY valid JSON in exactly this shape:
{
  "portal_tags": ["..."],   // zero or more of: before, progress, behind_wall, issue, completion, marketing
  "portal_caption": "..."   // a calm, factual, homeowner-friendly sentence
}

Tag definitions (multi-select — pick every tag that applies):
- before: existing condition before any work was done. The space looks "old" or in its starting state.
- progress: work in the middle of happening — demoed surfaces, exposed studs/joists, freshly framed walls, partial tile, etc.
- behind_wall: a permanent record of what's hidden behind drywall once it goes up — plumbing rough-in, electrical runs, blocking for shelves/grab bars, vent paths. THESE ARE PRECIOUS to the homeowner: future repairs, future renovations, resale.
- issue: a problem the contractor documented (water damage discovered, surprise sub-floor rot, code-non-compliant existing wiring). Keep these factual; the homeowner will see the photo.
- completion: the finished result of a specific area — installed tile, painted wall, mounted fixture.
- marketing: a particularly photogenic shot worth featuring (golden hour exterior, beautifully staged kitchen). Optional.

Caption rules:
- Aim for a single sentence, ≤ 120 chars when possible.
- Homeowner voice — calm, transparent, confidence-building. Avoid trade jargon when the homeowner won't recognize it; expand abbreviations.
- Describe what's visible PLUS why it matters when relevant ("ran a new gas line and added blocking for floating shelves").
- No filler ("Here's a photo of..."). Start with the noun or action.
- If the photo is ambiguous, write "Documented for the record" and leave portal_tags empty.

Edge cases:
- If the photo shows a person's face, do NOT describe the person; describe the work.
- If the image is blurry / dark / unidentifiable, return empty portal_tags and "Documented for the record".

Output ONLY the JSON. No prose, no markdown fences.`;

function extractJson(text: string): string {
  const stripped = text
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();
  if (stripped.startsWith('{')) return stripped;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return match[0];
  throw new Error('portal_enricher_response_not_json');
}

function coerceTags(raw: unknown): PortalPhotoTag[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set(PORTAL_PHOTO_TAGS as readonly string[]);
  const seen = new Set<PortalPhotoTag>();
  for (const v of raw) {
    if (typeof v === 'string' && allowed.has(v)) seen.add(v as PortalPhotoTag);
  }
  return Array.from(seen);
}

function coerceCaption(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const cleaned = raw.trim().replace(/\s+/g, ' ');
  if (cleaned.length === 0) return '';
  return cleaned.length > 240 ? `${cleaned.slice(0, 237)}…` : cleaned;
}

export function parsePortalEnricherResponse(text: string): PortalEnrichmentResult {
  const json = extractJson(text);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    throw new Error('portal_enricher_invalid_json');
  }
  return {
    portalTags: coerceTags(raw.portal_tags),
    portalCaption: coerceCaption(raw.portal_caption),
  };
}

export async function enrichPhotoForPortal(params: {
  imageBytes: Buffer;
  mimeType: string;
  model?: string;
  client?: Anthropic;
}): Promise<PortalEnrichmentResult> {
  const mediaType = SUPPORTED_MEDIA_TYPES.has(params.mimeType)
    ? (params.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
    : 'image/jpeg';
  const model = params.model ?? process.env.PHOTO_CLASSIFIER_MODEL ?? 'claude-haiku-4-5-20251001';
  const client = params.client ?? new Anthropic();

  const response = await client.messages.create({
    model,
    max_tokens: 360,
    system: PORTAL_ENRICHER_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType,
              data: params.imageBytes.toString('base64'),
            },
          },
          {
            type: 'text',
            text: 'Classify this photo for the homeowner portal and write a caption.',
          },
        ],
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('portal_enricher_no_text_block');
  }
  return parsePortalEnricherResponse(textBlock.text);
}
