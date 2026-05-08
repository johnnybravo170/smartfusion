/**
 * AI-assisted Gantt bootstrap.
 *
 * Given a project's budget categories, returns per-category
 * `start_offset_days` (from project start) and `duration_days` so the
 * bootstrap action can lay out a draft schedule that's smarter than
 * the static sequence_position table — particularly when category
 * names don't map cleanly to canonical trades.
 *
 * The AI is allowed to place tasks in parallel (multiple tasks sharing
 * a start_offset). Returns null on any failure; caller falls back to
 * the static serial layout so a model outage never breaks bootstrap.
 *
 * Suggestions, not commands. The GC will move things around afterwards
 * — this just gets them a sensible starting Gantt.
 */

import { gateway } from '@/lib/ai-gateway';

export type AiBootstrapInput = {
  projectName: string;
  projectDescription: string | null;
  /**
   * One entry per budget category. `tradeName` is the resolved trade
   * template name when one is mapped (lets the model lean on the
   * canonical sequence); null when the category is custom.
   */
  categories: Array<{
    id: string;
    name: string;
    estimateCents: number;
    displayOrder: number;
    tradeName: string | null;
  }>;
};

export type AiBootstrapTask = {
  budget_category_id: string;
  start_offset_days: number;
  duration_days: number;
};

const SYSTEM_PROMPT = `You are scheduling a residential renovation project for a small general contractor. The contractor sends you the project's budget categories; you return a sensible build order with realistic durations.

Return ONLY valid JSON matching this shape:

{
  "tasks": [
    {
      "budget_category_id": "uuid-from-input",
      "start_offset_days": 0,    // integer days from project start (0 = day 1)
      "duration_days": 3         // integer, minimum 1
    }
  ]
}

Rules:
- Output one task per input budget category. Don't drop or merge.
- start_offset_days and duration_days MUST be whole non-negative integers (duration_days >= 1).
- Allow parallel tasks. Plumbing rough-in and electrical rough-in often happen in the same week — give them the same or near-same start_offset_days.
- Use the canonical residential reno sequence as a prior:
   * 0–3:   Site prep, demo, disposal
   * 4–14:  Excavation, foundation, framing, roofing, sheathing, windows
   * 15–25: Plumbing rough, electrical rough, HVAC (often parallel)
   * 22–28: Insulation
   * 28–35: Drywall (hang, tape, mud, sand)
   * 35–55: Painting, tile, flooring, cabinets, fixtures (some parallel)
   * 55–65: Doors, mouldings, railings, gutters
   * 65+:   Punch list, final inspection
- Deviate from the canonical order when the project name suggests something specific (e.g. "Pizza Oven Deluxe" implies an outdoor masonry build with a different sequence than a kitchen reno).
- Realistic durations:
   * Demo: 2–5 days
   * Framing: 4–10 days
   * Drywall: 4–7 days
   * Tile: 2–4 days
   * Painting: 3–5 days
   * Punch list: 2–4 days
- Output ONLY the JSON. No prose, no markdown fences.`;

const MODEL = process.env.SCHEDULE_BOOTSTRAP_MODEL ?? 'claude-sonnet-4-6';

export async function generateAiBootstrap(
  input: AiBootstrapInput,
): Promise<AiBootstrapTask[] | null> {
  if (input.categories.length === 0) return null;

  const userPrompt = [
    `Project: ${input.projectName}`,
    input.projectDescription ? `Description: ${input.projectDescription}` : null,
    '',
    'Budget categories:',
    ...input.categories.map((c) => {
      const dollars = (c.estimateCents / 100).toLocaleString('en-CA', {
        style: 'currency',
        currency: 'CAD',
        maximumFractionDigits: 0,
      });
      const tradeHint = c.tradeName ? ` [maps to canonical trade: ${c.tradeName}]` : '';
      return `- ${c.id}: ${c.name} (${dollars})${tradeHint}`;
    }),
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await gateway().runChat({
      kind: 'chat',
      task: 'schedule_bootstrap',
      model_override: MODEL,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 4096,
    });
    const text = res.text.trim();
    if (!text) return null;

    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();

    const parsed = JSON.parse(cleaned) as { tasks?: unknown };
    const tasksRaw = parsed.tasks;
    if (!Array.isArray(tasksRaw)) return null;

    const knownIds = new Set(input.categories.map((c) => c.id));

    const sanitized: AiBootstrapTask[] = [];
    for (const t of tasksRaw) {
      if (!t || typeof t !== 'object') continue;
      const r = t as Record<string, unknown>;
      const id = r.budget_category_id;
      const offset = r.start_offset_days;
      const duration = r.duration_days;
      if (typeof id !== 'string' || !knownIds.has(id)) continue;
      if (typeof offset !== 'number' || !Number.isFinite(offset)) continue;
      if (typeof duration !== 'number' || !Number.isFinite(duration)) continue;
      sanitized.push({
        budget_category_id: id,
        start_offset_days: Math.max(0, Math.round(offset)),
        duration_days: Math.max(1, Math.round(duration)),
      });
    }

    // Require coverage of every category — partial returns risk silently
    // dropping tasks the GC expected to see. Easier to fall back than to
    // half-bootstrap.
    if (sanitized.length !== input.categories.length) {
      console.warn(
        `[schedule_bootstrap] AI returned ${sanitized.length} tasks for ${input.categories.length} categories; falling back to static layout.`,
      );
      return null;
    }
    return sanitized;
  } catch (err) {
    console.warn('generateAiBootstrap failed:', err);
    return null;
  }
}
