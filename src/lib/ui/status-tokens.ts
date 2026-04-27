/**
 * Canonical status-tag color tokens.
 *
 * One meaning → one color. Every status-badge component + every inline
 * status map in the app imports from here so the pills can't drift.
 * PATTERNS.md §7 points at this file as source of truth.
 *
 * Meanings (top-level tokens):
 *   - neutral     Draft / not started / cancelled / void — muted gray
 *   - info        In-flight / sent / submitted — blue
 *   - warning     In progress / pending approval / expired — amber
 *   - success     Accepted / approved / paid / complete — emerald
 *   - danger      Rejected / declined — red
 *   - hold        On hold / paused — slate
 *
 * Each token is a full Tailwind class string so callers can spread it
 * directly into `className`. Classes include hover + border variants so
 * they work as either `<Badge variant="outline">` or a bare span.
 */

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger' | 'hold';

export const statusToneClass: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground border-transparent hover:bg-muted',
  info: 'bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300',
  warning:
    'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300',
  success:
    'bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-300',
  danger:
    'bg-red-100 text-red-800 border-red-200 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-300',
  hold: 'bg-slate-100 text-slate-700 border-slate-200 hover:bg-slate-100 dark:bg-slate-800/60 dark:text-slate-300',
};

/** Quote lifecycle. */
export const quoteStatusTone = {
  draft: 'neutral',
  sent: 'info',
  accepted: 'success',
  rejected: 'danger',
  expired: 'warning',
} as const satisfies Record<string, StatusTone>;

/** Job lifecycle. */
export const jobStatusTone = {
  booked: 'info',
  in_progress: 'warning',
  complete: 'success',
  cancelled: 'neutral',
} as const satisfies Record<string, StatusTone>;

/** Customer-facing invoice. */
export const invoiceStatusTone = {
  draft: 'neutral',
  sent: 'info',
  paid: 'success',
  void: 'neutral',
} as const satisfies Record<string, StatusTone>;

/** Worker-facing invoice (time / expense submission from crew). */
export const workerInvoiceStatusTone = {
  draft: 'neutral',
  submitted: 'info',
  approved: 'success',
  rejected: 'danger',
  paid: 'success',
} as const satisfies Record<string, StatusTone>;

/** Project lifecycle stage. Mirrors jobStatusTone so 'active'/'in-progress'
 *  reads as warning (amber) and 'complete' reads as success (emerald) — the
 *  two need to be visually distinct in the projects list. */
export const projectStageTone = {
  planning: 'info',
  awaiting_approval: 'warning',
  active: 'warning',
  on_hold: 'hold',
  declined: 'danger',
  complete: 'success',
  cancelled: 'neutral',
} as const satisfies Record<string, StatusTone>;

/** Change order lifecycle. */
export const changeOrderStatusTone = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'success',
  declined: 'danger',
  voided: 'neutral',
} as const satisfies Record<string, StatusTone>;

/**
 * Task module tones. Tasks have a richer status palette than the rest of
 * the app (orange for material waits, purple for sub waits, teal for
 * verified) so we render them off a per-status class table instead of the
 * shared StatusTone enum. Kept here so the badge component still imports
 * everything from one file.
 */
export const taskStatusClass = {
  ready:
    'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300',
  in_progress: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300',
  waiting_client:
    'bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300',
  waiting_material:
    'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300',
  waiting_sub:
    'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300',
  blocked: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-300',
  done: 'bg-muted text-muted-foreground border-transparent',
  verified: 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300',
} as const;
