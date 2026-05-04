/**
 * AI cluster #4 — Henry suggests homeowner decisions.
 *
 * Pulls recent project context (memos, notes, photo captions, project
 * description) and asks Claude what decisions the contractor should
 * be queueing for the homeowner to make. Output is 0-3 suggestions
 * shaped like the createDecisionAction input — operator one-click
 * promotes them into real pending rows.
 *
 * Returns an empty array on any AI failure rather than throwing —
 * Henry's suggestions are optional polish, not a hard dependency.
 */

import { gateway } from '@/lib/ai-gateway';

export type DecisionSuggestion = {
  label: string;
  description: string | null;
  /** Optional pick-one options (paint colors, tile choices). */
  options: string[];
};

export type DecisionSuggesterContext = {
  projectName: string;
  projectDescription: string | null;
  /** Recent voice-memo transcripts (newest first). */
  recentMemos: string[];
  /** Recent free-form notes (newest first). */
  recentNotes: string[];
  /** Recent photo captions (newest first). */
  recentPhotoCaptions: string[];
  /** Already-pending decision labels — Henry should NOT duplicate. */
  pendingLabels: string[];
};

const DECISION_SUGGESTER_SYSTEM_PROMPT = `You are Henry, an AI assistant for a residential renovation contractor. You're proposing decisions the contractor should ask the homeowner to make, based on what's recently happened on this project.

Return ONLY valid JSON in exactly this shape:
{
  "suggestions": [
    {
      "label": "...",                 // imperative phrasing — "Pick a paint color", "Approve allowance bump", "Confirm fixture model"
      "description": "...",           // 1-2 sentences of context the homeowner needs to decide
      "options": ["...", "..."]      // 0-N strings — when applicable for pick-one votes (paint colors, tile picks). Empty array = binary approve/decline.
    }
  ]
}

Rules:
- Return 0-3 suggestions. Quality over quantity. If nothing decision-worthy is brewing, return an empty array.
- A "decision" is something the homeowner literally needs to choose, approve, or confirm — not a status update or a question for the contractor.
- Don't suggest anything already in the pendingLabels list. Don't repeat the same idea twice.
- Use the homeowner's voice: warm, plain language. Avoid trade jargon.
- For pick-one votes (paint colors, tile, fixtures), include the actual options as separate strings. For yes/no decisions, leave options empty.
- If the recent context is thin or generic, return an empty array. Don't invent decisions.

Output ONLY the JSON. No prose, no markdown fences.`;

const SUGGESTER_MODEL = process.env.PHOTO_CLASSIFIER_MODEL ?? 'claude-haiku-4-5-20251001';

function clip(arr: string[], n: number, maxChars = 800): string[] {
  return arr.slice(0, n).map((s) => (s.length > maxChars ? `${s.slice(0, maxChars)}…` : s));
}

export async function suggestDecisions(
  ctx: DecisionSuggesterContext,
): Promise<DecisionSuggestion[]> {
  // Bail early if there's nothing for the model to chew on — saves
  // the call and avoids hallucinated-from-thin-air suggestions.
  if (
    ctx.recentMemos.length === 0 &&
    ctx.recentNotes.length === 0 &&
    ctx.recentPhotoCaptions.length === 0 &&
    !ctx.projectDescription
  ) {
    return [];
  }

  const userBlocks: string[] = [];
  userBlocks.push(`Project: ${ctx.projectName}`);
  if (ctx.projectDescription) userBlocks.push(`Description: ${ctx.projectDescription}`);
  if (ctx.pendingLabels.length > 0) {
    userBlocks.push(
      `Already pending decisions (do NOT repeat):\n- ${ctx.pendingLabels.join('\n- ')}`,
    );
  }
  if (ctx.recentMemos.length > 0) {
    userBlocks.push(
      `Recent voice memos (newest first):\n${clip(ctx.recentMemos, 3, 600)
        .map((m) => `[memo] ${m}`)
        .join('\n')}`,
    );
  }
  if (ctx.recentNotes.length > 0) {
    userBlocks.push(
      `Recent notes (newest first):\n${clip(ctx.recentNotes, 5, 400)
        .map((m) => `[note] ${m}`)
        .join('\n')}`,
    );
  }
  if (ctx.recentPhotoCaptions.length > 0) {
    userBlocks.push(
      `Recent photo captions (newest first):\n${clip(ctx.recentPhotoCaptions, 8, 200)
        .map((m) => `[photo] ${m}`)
        .join('\n')}`,
    );
  }
  userBlocks.push(
    'What homeowner decisions should the contractor queue right now? Return 0-3 suggestions in JSON.',
  );

  let text = '';
  try {
    const res = await gateway().runChat({
      kind: 'chat',
      task: 'decision_suggest',
      model_override: SUGGESTER_MODEL,
      system: DECISION_SUGGESTER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userBlocks.join('\n\n') }],
      max_tokens: 800,
    });
    text = res.text.trim();
  } catch {
    return [];
  }

  // Parse JSON liberally — strip code fences, find first {...} block.
  const stripped = text
    .replace(/```json\s*/g, '')
    .replace(/```\s*/g, '')
    .trim();
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1) return [];
  let parsed: { suggestions?: unknown[] } = {};
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return [];
  }
  const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  return list
    .map((raw): DecisionSuggestion | null => {
      if (!raw || typeof raw !== 'object') return null;
      const r = raw as Record<string, unknown>;
      const label = typeof r.label === 'string' ? r.label.trim() : '';
      if (!label) return null;
      const description =
        typeof r.description === 'string' && r.description.trim().length > 0
          ? r.description.trim()
          : null;
      const options = Array.isArray(r.options)
        ? r.options
            .filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
            .map((o) => o.trim())
            .slice(0, 10)
        : [];
      return { label, description, options };
    })
    .filter((s): s is DecisionSuggestion => s !== null)
    .slice(0, 3);
}
