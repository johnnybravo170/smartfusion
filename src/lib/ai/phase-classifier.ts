/**
 * Name-based phase classifier for budget-category → canonical phase
 * mapping. Used by the Gantt bootstrap when a category isn't directly
 * mapped to a trade_template via the FK — keeps "Site prep + demo"
 * from landing mid-timeline because it's an unmapped custom name.
 *
 * Returns a canonical sequence_position (0-100) along the residential-
 * reno timeline. Unmatched names fall through to null; the bootstrap
 * uses a mid-timeline default in that case.
 *
 * Keep the keyword list ordered most-specific-first so e.g. "plumbing
 * fixtures" matches the fixtures phase before the plumbing rough phase.
 */

export type PhaseClassification = {
  /** Canonical phase key. */
  phase: string;
  /** sequence_position aligned with trade_templates.sequence_position. */
  sequencePosition: number;
  /** Plain-English label suitable for prompt hints. */
  label: string;
};

type Rule = {
  phase: string;
  label: string;
  sequencePosition: number;
  /** Lowercased substrings — any match counts. Order-sensitive. */
  keywords: string[];
};

const RULES: Rule[] = [
  // 0–10 site prep / demo
  {
    phase: 'demo',
    label: 'Demo / site prep',
    sequencePosition: 10,
    keywords: [
      'site prep',
      'demolition',
      'demo',
      'tear out',
      'tear-out',
      'tearout',
      'disposal',
      'dump',
      'haul out',
    ],
  },
  // 15–18 excavation / foundation
  {
    phase: 'excavation',
    label: 'Excavation / foundation',
    sequencePosition: 18,
    keywords: ['excavat', 'foundation', 'footing', 'concrete pour', 'slab'],
  },
  // 20 framing (structural — explicit "structural framing", "roof", "sheathing")
  {
    phase: 'framing',
    label: 'Framing',
    sequencePosition: 20,
    keywords: ['structural', 'framing', 'frame', 'roof', 'sheathing'],
  },
  // 30 windows & exterior doors
  {
    phase: 'windows_doors',
    label: 'Windows & doors',
    sequencePosition: 30,
    keywords: ['window', 'exterior door', 'patio door'],
  },
  // 78 plumbing fixtures (MUST run before plumbing-rough so "plumbing fixtures"
  // matches fixtures, not plumbing)
  {
    phase: 'plumbing_fixtures',
    label: 'Plumbing fixtures',
    sequencePosition: 78,
    keywords: ['plumbing fixture', 'plumbing fixtures', 'fixture', 'fixtures'],
  },
  // 35 plumbing rough
  {
    phase: 'plumbing',
    label: 'Plumbing rough-in',
    sequencePosition: 35,
    keywords: ['plumbing', 'plumb', 'rough plumbing'],
  },
  // 38 electrical rough
  {
    phase: 'electrical',
    label: 'Electrical rough-in',
    sequencePosition: 38,
    keywords: ['electrical', 'electric ', 'wiring', 'rough electrical'],
  },
  // 40 hvac
  {
    phase: 'hvac',
    label: 'HVAC',
    sequencePosition: 40,
    keywords: ['hvac', 'heating', 'cooling', 'mechanical', 'ductwork'],
  },
  // 45 insulation
  {
    phase: 'insulation',
    label: 'Insulation',
    sequencePosition: 45,
    keywords: ['insulat'],
  },
  // 50 drywall
  {
    phase: 'drywall',
    label: 'Drywall',
    sequencePosition: 50,
    keywords: ['drywall', 'taping', 'mudding', 'gypsum'],
  },
  // 65 tile
  {
    phase: 'tile',
    label: 'Tile',
    sequencePosition: 65,
    keywords: ['tile', 'backsplash'],
  },
  // 70 flooring
  {
    phase: 'flooring',
    label: 'Flooring',
    sequencePosition: 70,
    keywords: ['flooring', 'hardwood', 'lvp', 'carpet', 'vinyl plank'],
  },
  // 75 cabinets / kitchen / built-ins / specialty installs
  {
    phase: 'cabinets',
    label: 'Cabinets / kitchen / built-ins',
    sequencePosition: 75,
    keywords: [
      'cabinet',
      'cabinetry',
      'kitchen',
      'vanity',
      'vanities',
      'built-in',
      'closet',
      'pizza oven',
      'fireplace',
    ],
  },
  // 80 doors & mouldings (interior trim)
  {
    phase: 'doors_mouldings',
    label: 'Doors & mouldings',
    sequencePosition: 80,
    keywords: ['mould', 'molding', 'casing', 'baseboard', 'trim', 'interior door'],
  },
  // 60 paint (primer + finish — keeps it before tile/flooring in the
  // typical Henry order; many GCs paint primer pre-tile and touch up after).
  {
    phase: 'painting',
    label: 'Painting',
    sequencePosition: 60,
    keywords: ['paint', 'painting'],
  },
  // 88 interior finish (railings, ensuite, bedroom finishes, walk-in closets)
  {
    phase: 'interior_finish',
    label: 'Interior finishes',
    sequencePosition: 88,
    keywords: [
      'railing',
      'staircase',
      'ensuite',
      'bath finish',
      'bathroom finish',
      'bedroom finish',
      'finish carp',
    ],
  },
  // 32 siding / exterior cladding
  {
    phase: 'siding',
    label: 'Siding / exterior',
    sequencePosition: 32,
    keywords: ['siding', 'cladding', 'stucco', 'gutter'],
  },
  // 95 punch list
  {
    phase: 'punch_list',
    label: 'Punch list',
    sequencePosition: 95,
    keywords: ['punch', 'cleanup', 'walkthrough', 'walk through', 'final touch'],
  },
];

export function classifyCategoryName(name: string): PhaseClassification | null {
  const lower = (name ?? '').toLowerCase();
  if (!lower) return null;
  for (const rule of RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return {
        phase: rule.phase,
        sequencePosition: rule.sequencePosition,
        label: rule.label,
      };
    }
  }
  return null;
}
