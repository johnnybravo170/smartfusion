/**
 * Canonical content for the HeyHenry ops memory taxonomy. Consumed by the
 * `ops_memory_guide` MCP tool and the `/admin/memory-guide` page. Single
 * source of truth so agents + humans see identical guidance.
 */

export type SurfaceKey = 'kanban' | 'worklog' | 'ideas' | 'knowledge' | 'decisions';

export type Surface = {
  key: SurfaceKey;
  label: string;
  oneLiner: string;
  useFor: string[];
  doNotUseFor: string[];
  write_tool: string;
  read_tools: string[];
  admin_tools?: string[];
  admin_path: string;
  examples: string[];
};

export const SURFACES: Surface[] = [
  {
    key: 'kanban',
    label: 'Kanban',
    oneLiner: 'Actionable closable work with a clear done-condition.',
    useFor: [
      'A feature to build.',
      'A bug to fix.',
      'A content piece to ship.',
      'Anything you can mark "done".',
    ],
    doNotUseFor: [
      'Something that already happened (→ worklog).',
      'A half-formed thought (→ ideas).',
      'An evergreen fact (→ knowledge).',
      'A choice with reasoning (→ decisions).',
    ],
    write_tool: 'kanban_card_create',
    read_tools: ['kanban_card_list', 'kanban_card_get', 'kanban_launch_rollup'],
    admin_path: '/admin/kanban',
    examples: [
      'Build V1 payments flow (size_points=8, epic:payments).',
      'Fix overdue badge color on dashboard (size_points=1).',
    ],
  },
  {
    key: 'worklog',
    label: 'Worklog',
    oneLiner: 'Things that HAPPENED. Append-only, time-stamped feed.',
    useFor: [
      'Agent run summaries.',
      'What Jonathan did today.',
      'Customer interactions.',
      'Weekly digests.',
    ],
    doNotUseFor: [
      'Actionable work (→ kanban).',
      'Evergreen truth (→ knowledge).',
      'Choices with reasoning (→ decisions).',
      'Half-formed ideas (→ ideas).',
    ],
    write_tool: 'worklog_add',
    read_tools: ['worklog_list'],
    admin_path: '/worklog',
    examples: [
      '"Deployed autoresponder v2 to heyhenry.io."',
      '"Call with Will — pressure-washing pilot ready to onboard."',
    ],
  },
  {
    key: 'ideas',
    label: 'Ideas',
    oneLiner: 'Half-formed thoughts BEFORE they become plans.',
    useFor: [
      'Options to consider.',
      'Questions Jonathan asked out loud.',
      'Patterns noticed but not yet acted on.',
    ],
    doNotUseFor: [
      'Actionable work (→ kanban).',
      'Established truth (→ knowledge).',
      'Things that happened (→ worklog).',
    ],
    write_tool: 'ideas_add',
    read_tools: ['ideas_list', 'ideas_get'],
    admin_path: '/ideas',
    examples: [
      '"Maybe we should prefill the customer picker with the last-used customer."',
      '"Is there a way to auto-detect which columns a CSV has?"',
    ],
  },
  {
    key: 'knowledge',
    label: 'Knowledge',
    oneLiner: 'Evergreen facts — still true in 6 months. Semantic-searchable.',
    useFor: [
      'ICP definitions.',
      'Product constraints.',
      'External API quirks.',
      'Customer personas.',
      'Pricing structures.',
      'Naming conventions.',
    ],
    doNotUseFor: ['Date-stamped events (→ worklog).', 'Choices-with-reasoning (→ decisions).'],
    write_tool: 'knowledge_write',
    read_tools: ['knowledge_search'],
    admin_tools: ['knowledge_update', 'knowledge_delete'],
    admin_path: '/knowledge',
    examples: [
      '"HeyHenry ICP: solo pressure-washing contractors in Canada, $80k–$300k ARR."',
      '"Stripe webhook retries: up to 3 days, exponential backoff."',
    ],
  },
  {
    key: 'decisions',
    label: 'Decisions',
    oneLiner: 'A CHOICE we made, WITH reasoning.',
    useFor: [
      'Jonathan picks option A over B.',
      'An architectural call is made.',
      'A strategic direction is committed.',
    ],
    doNotUseFor: [
      'Ideas still being explored (→ ideas).',
      'Facts that aren\u2019t choices (→ knowledge).',
    ],
    write_tool: 'decisions_add',
    read_tools: ['decisions_list'],
    admin_path: '/decisions',
    examples: [
      '"Chose Resend over SendGrid: better DX, same deliverability, cheaper at our volume."',
      '"Deferred quote-import to post-V1: blocks on job-costing spec."',
    ],
  },
];

export const THREE_SECOND_HEURISTIC = [
  'Can someone mark it "done"?  → kanban',
  'Did it already happen?         → worklog',
  'Is it still just a thought?    → ideas',
  'Will it be true in 6 months?   → knowledge',
  'Did we pick A over B?          → decisions',
];

export const CROSS_LINKING_PATTERNS = [
  'Idea graduates to action → create kanban_card, link via `related_type=\u201didea\u201d, related_id=<idea_id>`.',
  'Decision produces work   → create kanban_card, link via `related_type=\u201ddecision\u201d`. Worklog entry when it ships.',
  'Weekly recap             → worklog entry titled "Week of YYYY-MM-DD", plus a knowledge doc tagged `weekly-digest` for long-term searchability.',
  'Incident post-mortem     → decisions_add for the choice you made in response, knowledge_write for what you learned that is evergreen.',
];

export function renderMarkdown(onlySurface?: SurfaceKey): string {
  const lines: string[] = [];
  lines.push('# HeyHenry Ops Memory Guide');
  lines.push('');
  lines.push(
    'Five surfaces. Each has ONE job. Pick the right one before writing so humans and agents never rehash the same work.',
  );
  lines.push('');
  lines.push('## The 3-second heuristic');
  lines.push('');
  for (const h of THREE_SECOND_HEURISTIC) lines.push(`- ${h}`);
  lines.push('');

  const surfaces = onlySurface ? SURFACES.filter((s) => s.key === onlySurface) : SURFACES;
  for (const s of surfaces) {
    lines.push(`## ${s.label}`);
    lines.push('');
    lines.push(`**What it is:** ${s.oneLiner}`);
    lines.push('');
    lines.push(`**Write tool:** \`${s.write_tool}\``);
    lines.push(`**Read tools:** ${s.read_tools.map((t) => `\`${t}\``).join(', ')}`);
    if (s.admin_tools && s.admin_tools.length > 0) {
      lines.push(`**Admin tools:** ${s.admin_tools.map((t) => `\`${t}\``).join(', ')}`);
    }
    lines.push(`**Admin page:** ${s.admin_path}`);
    lines.push('');
    lines.push('**Use for:**');
    for (const u of s.useFor) lines.push(`- ${u}`);
    lines.push('');
    lines.push('**Do NOT use for:**');
    for (const u of s.doNotUseFor) lines.push(`- ${u}`);
    lines.push('');
    lines.push('**Examples:**');
    for (const e of s.examples) lines.push(`- ${e}`);
    lines.push('');
  }

  if (!onlySurface) {
    lines.push('## Cross-linking patterns');
    lines.push('');
    for (const p of CROSS_LINKING_PATTERNS) lines.push(`- ${p}`);
    lines.push('');
    lines.push('## Rule of thumb');
    lines.push('');
    lines.push(
      'If you\u2019re writing the same idea twice to two surfaces, STOP. Write it once to the right surface, then cross-link from the others.',
    );
  }
  return lines.join('\n');
}
