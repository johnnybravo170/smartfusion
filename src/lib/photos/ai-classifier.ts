/**
 * Claude Vision classifier for photos.
 *
 * Given an image + job context + tenant prefs, returns:
 *   - tag classification with confidence
 *   - caption (single sentence, operator-voiced when possible)
 *   - quality flags: blurry | too_dark | low_contrast | duplicate_suspect
 *
 * Prompt is exported for unit testing; network call is separate so tests
 * can mock the SDK.
 */

import { gateway } from '@/lib/ai-gateway';

export type Tag =
  | 'before'
  | 'after'
  | 'progress'
  | 'damage'
  | 'materials'
  | 'equipment'
  | 'serial'
  | 'concern'
  | 'other';

export type QualityFlags = {
  blurry?: boolean;
  too_dark?: boolean;
  low_contrast?: boolean;
  notes?: string;
};

export type ClassifierResult = {
  tag: Tag;
  tagConfidence: number; // 0..1
  caption: string;
  captionConfidence: number; // 0..1
  qualityFlags: QualityFlags;
  showcaseScore: number; // 0..1 — is this a portfolio-worthy shot?
  showcaseReason: string | null; // one-line justification, null if low score
};

export type ClassifierJobContext = {
  vertical?: string | null; // e.g. 'pressure_washing'
  jobStatus?: string | null; // e.g. 'booked' | 'in_progress' | 'complete'
  surfaces?: string[]; // e.g. ['driveway', 'siding'] from linked quote
  customerCity?: string | null;
  scheduledAt?: string | null;
  takenAt?: string | null; // EXIF/user-provided capture time
};

export type ClassifierPrefs = {
  // Per-tenant vocabulary: { "progress": "action" } renames the tag in captions.
  // Tag classification itself stays canonical.
  tagVocabulary?: Record<string, string>;
  captionStyle?: 'concise' | 'descriptive'; // default 'concise'
};

const SUPPORTED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/**
 * Build the system + user prompt. Exported for testing.
 */
export function buildClassifierPrompt(
  context: ClassifierJobContext,
  prefs: ClassifierPrefs,
): { system: string; user: string } {
  const captionStyle = prefs.captionStyle ?? 'concise';

  const system = `You are Henry, an AI assistant for field-service contractors. Your job is to classify a work-site photo and write a short caption for it.

You must return ONLY valid JSON with exactly these fields:
{
  "tag": "before" | "after" | "progress" | "damage" | "materials" | "equipment" | "serial" | "concern" | "other",
  "tag_confidence": 0.0 to 1.0,
  "caption": "short factual description of what is visible",
  "caption_confidence": 0.0 to 1.0,
  "quality": {
    "blurry": true|false,
    "too_dark": true|false,
    "low_contrast": true|false,
    "notes": "optional short note"
  },
  "showcase_score": 0.0 to 1.0,
  "showcase_reason": "one short sentence, or empty string"
}

TAG DEFINITIONS:
- before:    a surface or area in its pre-work state (dirty, damaged, unrenovated)
- after:     the same type of surface/area visibly cleaned, repaired, or completed
- progress:  mid-job action shot (spraying, painting, laying, framing, scraping, etc.)
- damage:    a defect, pre-existing issue, or discovered problem that matters for the job
- materials: receipts, boxes, product labels, paint cans, tile pallets, bags of concrete
- equipment: truck, tools, pressure washer, ladder, scaffolding set up
- serial:    a serial number, model plate, or install sticker
- concern:   something the operator will want to flag for the customer (hazard, unexpected finding)
- other:     none of the above fits

CAPTION RULES:
- 1 sentence, ${captionStyle === 'concise' ? 'under 80 characters' : 'under 140 characters'}
- Describe what is actually visible, not what you assume
- No marketing fluff. No "beautiful transformation." No emojis.
- Reference the surface type (driveway, deck, roof, etc.) if identifiable
- If the photo is ambiguous, say so in the caption and lower caption_confidence

CONFIDENCE RULES:
- Tag confidence ≥ 0.90 means you are almost certain
- 0.60–0.90 means it's probably right but another tag is plausible
- < 0.60 means you're genuinely unsure — use 'other' if nothing clearly fits

QUALITY RULES:
- blurry: true only if motion blur or focus failure is obvious
- too_dark: true if underexposed enough that the subject is hard to identify
- low_contrast: true if the subject blends into the background
- Do NOT flag quality for normal variation; only flag obvious problems

SHOWCASE RULES:
- showcase_score: how portfolio-worthy is this shot, independent of the tag?
  - 0.85+: striking "after" or dramatic before/after context — the kind of photo a contractor would pin to their website
  - 0.70–0.85: clean, well-composed, good lighting, clearly shows finished work
  - 0.40–0.70: decent documentation photo but not marketing material
  - < 0.40: progress/materials/equipment/serial/concern shots, or anything with quality issues
- Reward: good lighting, full subject in frame, clean composition, dramatic before/after, visible craftsmanship
- Penalize: blurry/dark/low-contrast, clutter, people's faces, partial subjects, receipts/boxes/tools as the main subject
- showcase_reason: one short sentence (under 80 chars) — what makes it great (or empty string if score < 0.70)`;

  const lines: string[] = ['Classify this photo.'];
  if (context.vertical) lines.push(`Business vertical: ${context.vertical}`);
  if (context.jobStatus) lines.push(`Job status when photo taken: ${context.jobStatus}`);
  if (context.surfaces && context.surfaces.length > 0) {
    lines.push(`Surfaces listed on the linked quote: ${context.surfaces.join(', ')}`);
  }
  if (context.customerCity) lines.push(`City: ${context.customerCity}`);
  if (context.takenAt) lines.push(`Taken at: ${context.takenAt}`);
  if (context.scheduledAt) lines.push(`Job scheduled at: ${context.scheduledAt}`);
  lines.push('');
  lines.push('Respond with the JSON object only. No markdown fences, no prose.');

  return { system, user: lines.join('\n') };
}

/**
 * Parse Claude's response into a ClassifierResult. Tolerates markdown fences
 * or stray text around the JSON.
 */
export function parseClassifierResponse(text: string): ClassifierResult {
  const jsonText = extractJson(text);
  const raw = JSON.parse(jsonText) as Partial<{
    tag: string;
    tag_confidence: number;
    caption: string;
    caption_confidence: number;
    quality: Record<string, unknown>;
    showcase_score: number;
    showcase_reason: string;
  }>;

  const tag = coerceTag(raw.tag);
  const tagConfidence = coerceConfidence(raw.tag_confidence);
  const caption = (raw.caption ?? '').toString().trim();
  const captionConfidence = coerceConfidence(raw.caption_confidence);
  const quality = raw.quality ?? {};
  const showcaseScore = coerceConfidence(raw.showcase_score);
  const reasonText = typeof raw.showcase_reason === 'string' ? raw.showcase_reason.trim() : '';

  return {
    tag,
    tagConfidence,
    caption,
    captionConfidence,
    qualityFlags: {
      blurry: quality.blurry === true,
      too_dark: quality.too_dark === true,
      low_contrast: quality.low_contrast === true,
      notes: typeof quality.notes === 'string' ? quality.notes : undefined,
    },
    showcaseScore,
    showcaseReason: reasonText.length > 0 ? reasonText : null,
  };
}

function extractJson(text: string): string {
  const stripped = text
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();
  if (stripped.startsWith('{')) return stripped;
  const match = text.match(/\{[\s\S]*\}/);
  if (match) return match[0];
  throw new Error('classifier_response_not_json');
}

function coerceTag(raw: unknown): Tag {
  const allowed: Tag[] = [
    'before',
    'after',
    'progress',
    'damage',
    'materials',
    'equipment',
    'serial',
    'concern',
    'other',
  ];
  if (typeof raw === 'string' && allowed.includes(raw as Tag)) return raw as Tag;
  return 'other';
}

function coerceConfidence(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Run the classifier on a single image. Returns a parsed result, throws on
 * transport or parse failures.
 */
export async function classifyPhoto(params: {
  imageBytes: Buffer;
  mimeType: string;
  context: ClassifierJobContext;
  prefs: ClassifierPrefs;
  model?: string;
}): Promise<ClassifierResult> {
  const mediaType = SUPPORTED_MEDIA_TYPES.has(params.mimeType)
    ? (params.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp')
    : 'image/jpeg';

  const { system, user } = buildClassifierPrompt(params.context, params.prefs);
  const model = params.model ?? process.env.PHOTO_CLASSIFIER_MODEL ?? 'claude-haiku-4-5-20251001';

  const res = await gateway().runVision({
    kind: 'vision',
    task: 'photo_classify_internal',
    model_override: model,
    prompt: `${system}\n\n${user}`,
    file: { mime: mediaType, base64: params.imageBytes.toString('base64') },
    max_tokens: 512,
  });
  return parseClassifierResponse(res.text);
}
