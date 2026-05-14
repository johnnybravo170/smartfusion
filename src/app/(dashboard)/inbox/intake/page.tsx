/**
 * Universal /inbox/intake — single activity log + triage surface for
 * everything Henry captures (email forwards, project drop zone uploads,
 * lead form submissions, voice memos, web share targets).
 *
 * V2 Phase C: list rows with filters + per-row source/intent/disposition
 * chips + thumbnail. State-aware action menu (apply / edit / move /
 * undo / dismiss) lands in Phase D — for now each row links to the
 * existing per-draft detail view.
 */

import { Mail } from 'lucide-react';
import { IntakeFilters } from '@/components/features/inbox/intake-filters';
import { IntakeRow } from '@/components/features/inbox/intake-row';
import { getCurrentTenant } from '@/lib/auth/helpers';
import {
  type IntakeDisposition,
  type IntakeSource,
  listInboxIntake,
} from '@/lib/db/queries/intake-drafts';

const VALID_SOURCES: readonly IntakeSource[] = [
  'email',
  'project_drop',
  'lead_form',
  'voice',
  'web_share',
];
const VALID_DISPOSITIONS: readonly (IntakeDisposition | 'all')[] = [
  'pending_review',
  'applied',
  'dismissed',
  'error',
  'all',
];

type RawSearchParams = Record<string, string | string[] | undefined>;

function pickString(v: string | string[] | undefined): string {
  return typeof v === 'string' ? v.trim() : '';
}

export const metadata = { title: 'Intake — Inbox — HeyHenry' };

export default async function InboxIntakePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const sp = await searchParams;
  const sourceParam = pickString(sp.source);
  const dispositionParam = pickString(sp.disposition);
  const search = pickString(sp.q);
  const projectId = pickString(sp.project) || undefined;

  const source = (VALID_SOURCES as readonly string[]).includes(sourceParam)
    ? (sourceParam as IntakeSource)
    : undefined;
  const disposition = (VALID_DISPOSITIONS as readonly string[]).includes(dispositionParam)
    ? (dispositionParam as IntakeDisposition | 'all')
    : undefined;

  const tenant = await getCurrentTenant();
  if (!tenant) {
    return <p className="text-sm text-muted-foreground">Not signed in.</p>;
  }

  const rows = await listInboxIntake({
    source,
    disposition,
    search: search || undefined,
    projectId,
  });

  const showForwardCallout = !source || source === 'email';

  return (
    <div className="space-y-4">
      {showForwardCallout && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <Mail className="size-4 text-muted-foreground" />
          <span>
            Forward bills, sub-quotes, drawings, photos, customer emails — anything — to{' '}
            <code className="font-mono">henry@inbound.heyhenry.io</code>.
          </span>
          <span className="text-muted-foreground">
            Henry classifies and stages each one here for your confirmation.
          </span>
        </div>
      )}

      <IntakeFilters
        defaultSource={source ?? ''}
        defaultDisposition={disposition ?? ''}
        defaultSearch={search}
      />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-sm text-muted-foreground">
          {search || source || disposition
            ? 'No intake items match those filters.'
            : "Henry's inbox is empty. Things you forward, drop, or speak land here first."}
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <IntakeRow key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}
