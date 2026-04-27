/**
 * Canonical status-tag color tokens.
 *
 * One meaning → one color. Every status-badge component + every inline
 * status map in the app imports from here so the pills can't drift.
 * PATTERNS.md §7 points at this file as source of truth.
 *
 * Eyes get trained by colors — same state, same color, everywhere.
 *
 * Meanings (top-level tokens):
 *   - neutral     Draft / not started / cancelled / void — muted gray
 *   - info        Scheduled / sent / submitted (in-flight, awaiting external) — blue
 *   - warning     In progress / pending approval / expired — amber
 *   - success     Money/approval positive: paid / accepted / approved — emerald
 *   - done        Work finished, archived: project/job/task complete — indigo
 *   - danger      Rejected / declined / blocked — red
 *   - hold        On hold / paused / waiting on external — slate
 *
 * Note `success` vs `done`: success is "yes, money/approval came through"
 * (paid, accepted, approved); done is "the work is finished and put away"
 * (project complete, job complete, task done). They used to share emerald
 * which made the projects list ambiguous — emerald now stays positive-money
 * only, indigo carries the "shipped" feel.
 *
 * Each token is a full Tailwind class string so callers can spread it
 * directly into `className`. Classes include hover + border variants so
 * they work as either `<Badge variant="outline">` or a bare span.
 */

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'done' | 'danger' | 'hold';

export const statusToneClass: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground border-transparent hover:bg-muted',
  info: 'bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300',
  warning:
    'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300',
  success:
    'bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-300',
  done: 'bg-indigo-100 text-indigo-800 border-indigo-200 hover:bg-indigo-100 dark:bg-indigo-900/30 dark:text-indigo-300',
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
  complete: 'done',
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

/** Project lifecycle stage. Mirrors jobStatusTone — 'active' reads warning
 *  (amber, in progress), 'complete' reads done (indigo, shipped). */
export const projectStageTone = {
  planning: 'info',
  awaiting_approval: 'warning',
  active: 'warning',
  on_hold: 'hold',
  declined: 'danger',
  complete: 'done',
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
 * Task module classes. Where a task state has a parallel in the unified
 * StatusTone system (in_progress, blocked, done), we reuse the same class
 * string for visual consistency. The waiting_* states keep distinct
 * task-specific colors because the *reason* for the wait is meaningful
 * signal in the task UI; verified gets its own teal because it's a
 * "double-confirmed" state beyond plain done.
 */
export const taskStatusClass = {
  // Aligned with StatusTone:
  in_progress: statusToneClass.warning, // amber, matches projects.active + jobs.in_progress
  blocked: statusToneClass.danger,
  done: statusToneClass.done, // indigo, matches projects.complete + jobs.complete
  // Task-specific:
  ready:
    'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300',
  waiting_client: statusToneClass.hold, // slate — paused on external (client response)
  waiting_material:
    'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-300',
  waiting_sub:
    'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-900/30 dark:text-purple-300',
  verified: 'bg-teal-100 text-teal-800 border-teal-200 dark:bg-teal-900/30 dark:text-teal-300',
} as const;
