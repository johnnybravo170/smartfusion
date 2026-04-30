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
 *   - done        Work finished, archived: project/job/task complete — dark slate (filled)
 *   - danger      Rejected / declined / blocked — red
 *   - hold        On hold / paused / waiting on external — slate
 *
 * Note `success` vs `done`: success is "yes, money/approval came through"
 * (paid, accepted, approved); done is "the work is finished and put away"
 * (project complete, job complete, task done). They used to share emerald
 * which made the projects list ambiguous — emerald now stays positive-money
 * only. Done was tried as indigo for "shipped" feel but read too close to
 * info-blue for normal and CVD vision; switched to filled dark slate
 * (2026-04-28) which reads "archived" and is perceptually maximally
 * distant from every other tone.
 *
 * Each token is a full Tailwind class string so callers can spread it
 * directly into `className`. Classes include hover + border variants so
 * they work as either `<Badge variant="outline">` or a bare span.
 *
 * `statusToneIcon` carries a leading glyph for each tone — color is
 * trained-in but icons are for color-blind users (and screen readers
 * via aria-hidden). WCAG SC 1.4.1: don't rely on color alone.
 */

import {
  BadgeCheck,
  Check,
  CheckCircle2,
  Circle,
  Hourglass,
  type LucideIcon,
  Package,
  PauseCircle,
  Play,
  Send,
  Users,
  XCircle,
} from 'lucide-react';

export type StatusTone = 'neutral' | 'info' | 'warning' | 'success' | 'done' | 'danger' | 'hold';

export const statusToneIcon: Record<StatusTone, LucideIcon> = {
  neutral: Circle,
  info: Send,
  warning: Hourglass,
  success: Check,
  done: CheckCircle2,
  danger: XCircle,
  hold: PauseCircle,
};

export const statusToneClass: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground border-transparent hover:bg-muted',
  info: 'bg-blue-100 text-blue-800 border-blue-200 hover:bg-blue-100 dark:bg-blue-900/30 dark:text-blue-300',
  warning:
    'bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-300',
  success:
    'bg-emerald-100 text-emerald-800 border-emerald-200 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-300',
  // Filled dark slate. Indigo was the original pick (kept emerald free for
  // success) but read too close to info-blue for normal AND CVD vision —
  // shipped → "archived/sealed" reads better as a dark fill anyway.
  done: 'bg-slate-800 text-slate-50 border-slate-800 hover:bg-slate-800 dark:bg-slate-200 dark:text-slate-900 dark:border-slate-200',
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

/** Project lifecycle stage. Each stage gets a distinct tone so the list
 *  view reads at a glance — no two stages share a colour:
 *    planning           — neutral muted gray, internal draft, nothing sent
 *    awaiting_approval  — info blue, sent and waiting on the customer
 *    active             — success green, money flowing and work happening
 *    on_hold            — warning amber, paused (not failed, just stopped)
 *    declined           — danger red, customer said no
 *    complete           — done dark slate filled, shipped
 *    cancelled          — hold light slate, filed away (dropped before/after)
 *
 *  Notes:
 *  - `active` reads success (green) rather than warning (amber) — an active
 *    job is the *healthy* state for a contractor. Amber is reserved for
 *    paused/at-risk states.
 *  - `cancelled` and `planning` are both quiet/dim by intent, but use
 *    different tones so they don't visually collide on the list.
 */
export const projectStageTone = {
  planning: 'neutral',
  awaiting_approval: 'info',
  active: 'success',
  on_hold: 'warning',
  declined: 'danger',
  complete: 'done',
  cancelled: 'hold',
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
export const taskStatusIcon: Record<string, LucideIcon> = {
  in_progress: Hourglass,
  blocked: XCircle,
  done: CheckCircle2,
  ready: Play,
  waiting_client: Hourglass,
  waiting_material: Package,
  waiting_sub: Users,
  verified: BadgeCheck,
};

export const taskStatusClass = {
  // Aligned with StatusTone:
  in_progress: statusToneClass.warning, // amber, matches projects.active + jobs.in_progress
  blocked: statusToneClass.danger,
  done: statusToneClass.done, // filled dark slate, matches projects.complete + jobs.complete
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
