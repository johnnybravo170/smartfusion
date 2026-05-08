/**
 * Phase-name → Tailwind color classes for Gantt bars.
 *
 * Two layers per phase:
 *   - `firm`: solid bar fill (operator's confidence='firm' or default)
 *   - `rough`: dashed border + tinted fill (operator's confidence='rough')
 *
 * Customer-facing Gantt only uses `firm` — homeowners don't need the
 * confidence dimension. High-disruption tasks override the phase color
 * with the warning amber.
 *
 * Match is case-insensitive against `project_phases.name` (the trigger-
 * seeded names from migration 0122). Custom phase names fall through
 * to a neutral primary color.
 */

export type GanttPhaseColors = {
  /** Solid bar fill for confidence=firm and the customer view. */
  firm: string;
  /** Dashed/tinted variant for confidence=rough. */
  rough: string;
};

const NEUTRAL: GanttPhaseColors = {
  firm: 'bg-primary',
  rough: 'border border-dashed border-primary bg-primary/10',
};

/**
 * Canonical mappings keyed by lower-cased phase name. Aligned with the
 * default phase seed in `seed_project_phases_on_insert()` (migration
 * 0122) and the `trade_templates.typical_phase` strings used by the
 * Gantt bootstrap.
 */
const PHASE_COLOR_MAP: Record<string, GanttPhaseColors> = {
  'planning & selections': {
    firm: 'bg-slate-500',
    rough: 'border border-dashed border-slate-500 bg-slate-500/10',
  },
  demo: {
    firm: 'bg-orange-500',
    rough: 'border border-dashed border-orange-500 bg-orange-500/10',
  },
  framing: {
    firm: 'bg-blue-500',
    rough: 'border border-dashed border-blue-500 bg-blue-500/10',
  },
  'rough-in': {
    firm: 'bg-teal-500',
    rough: 'border border-dashed border-teal-500 bg-teal-500/10',
  },
  inspection: {
    firm: 'bg-cyan-500',
    rough: 'border border-dashed border-cyan-500 bg-cyan-500/10',
  },
  drywall: {
    firm: 'bg-purple-500',
    rough: 'border border-dashed border-purple-500 bg-purple-500/10',
  },
  'cabinets & fixtures': {
    firm: 'bg-amber-500',
    rough: 'border border-dashed border-amber-500 bg-amber-500/10',
  },
  finishes: {
    firm: 'bg-green-500',
    rough: 'border border-dashed border-green-500 bg-green-500/10',
  },
  'punch list': {
    firm: 'bg-rose-500',
    rough: 'border border-dashed border-rose-500 bg-rose-500/10',
  },
  'final walkthrough': {
    firm: 'bg-emerald-500',
    rough: 'border border-dashed border-emerald-500 bg-emerald-500/10',
  },
};

export function phaseColorFor(phaseName: string | null | undefined): GanttPhaseColors {
  if (!phaseName) return NEUTRAL;
  return PHASE_COLOR_MAP[phaseName.trim().toLowerCase()] ?? NEUTRAL;
}
