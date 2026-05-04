/**
 * Document type classifier. Given a filename (and optionally a snippet
 * of extracted text), returns the most likely DocumentType for a
 * project_documents row.
 *
 * Used by the upload flow to pre-fill the Type select instead of
 * always defaulting to "other". Operator can still override.
 *
 * Two-stage: cheap regex heuristics first (most filenames are
 * descriptive enough), AI fallback only when the heuristics are
 * ambiguous. Saves a Claude call on the common case.
 */

import { gateway } from '@/lib/ai-gateway';
import { type DocumentType, isDocumentType } from '@/lib/validators/project-document';

/**
 * Cheap regex-based classifier. Runs first; AI only fires when this
 * returns null. Patterns are intentionally generous — false positives
 * on "permit" / "warranty" / "manual" matter less than fast
 * pre-filling on the common case.
 */
function classifyByHeuristic(filename: string): DocumentType | null {
  const f = filename.toLowerCase();
  // Order matters — more specific terms first.
  if (/\b(coi|certificate of insurance|insurance cert)\b/.test(f)) return 'coi';
  if (/\b(permit|building permit|electrical permit|gas permit)\b/.test(f)) return 'permit';
  if (/\b(warranty|guarantee|labour warranty|labor warranty)\b/.test(f)) return 'warranty';
  if (/\b(manual|owner.?s manual|user manual|installation manual|use & care)\b/.test(f))
    return 'manual';
  if (/\b(inspection|inspection report|signed off|sign-off)\b/.test(f)) return 'inspection';
  if (/\b(contract|agreement|signed contract|cca|service agreement)\b/.test(f)) return 'contract';
  return null;
}

const AI_SYSTEM_PROMPT = `You classify uploaded files for a residential construction project's homeowner-facing document store.

Return ONLY one of these exact tokens, no prose:
contract | permit | warranty | manual | inspection | coi | other

Categories:
- contract: signed contracts, service agreements, change orders that are themselves contracts.
- permit: building / electrical / plumbing / gas permits issued by the city.
- warranty: workmanship or product warranties, guarantees.
- manual: owner's manuals, use & care guides, installation manuals.
- inspection: inspection reports, sign-offs, third-party reviews.
- coi: certificates of insurance (sub-trade or general contractor liability).
- other: doesn't clearly match the above.

If the filename strongly indicates the category, that's enough. Don't infer from the project — be conservative; "other" is fine when unsure.`;

const AI_FALLBACK_MODEL = process.env.PHOTO_CLASSIFIER_MODEL ?? 'claude-haiku-4-5-20251001';

export async function classifyDocumentType(input: {
  filename: string;
  /** Optional first 1-2 KB of text from the file. Helps with generic names. */
  textSnippet?: string;
  model?: string;
}): Promise<DocumentType> {
  const heuristic = classifyByHeuristic(input.filename);
  if (heuristic) return heuristic;

  const userParts: string[] = [`Filename: ${input.filename}`];
  if (input.textSnippet && input.textSnippet.length > 0) {
    userParts.push(`Text snippet:\n${input.textSnippet.slice(0, 1500)}`);
  }
  userParts.push('Return one of: contract | permit | warranty | manual | inspection | coi | other');

  let text = '';
  try {
    const res = await gateway().runChat({
      kind: 'chat',
      task: 'document_type_classify',
      model_override: input.model ?? AI_FALLBACK_MODEL,
      system: AI_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userParts.join('\n\n') }],
      max_tokens: 16,
    });
    text = res.text.trim().toLowerCase();
  } catch {
    // Fall through to 'other' on any AI error.
  }

  // The model occasionally adds punctuation or prose around the token.
  const cleaned = text.replace(/[^a-z]/g, '');
  return isDocumentType(cleaned) ? (cleaned as DocumentType) : 'other';
}
