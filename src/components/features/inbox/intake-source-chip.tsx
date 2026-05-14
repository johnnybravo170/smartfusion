/**
 * Tiny visual badge for an intake_drafts row: which surface did this
 * arrive through. Shared by the inbox row and any future surface that
 * wants to show source attribution at a glance.
 */

import { Inbox, Mail, Mic, Share2, UploadCloud } from 'lucide-react';
import type { IntakeSource } from '@/lib/db/queries/intake-drafts';

const SOURCE_META: Record<
  IntakeSource,
  { Icon: React.ComponentType<{ className?: string }>; label: string }
> = {
  email: { Icon: Mail, label: 'Email' },
  project_drop: { Icon: UploadCloud, label: 'Drop zone' },
  lead_form: { Icon: Inbox, label: 'Lead form' },
  voice: { Icon: Mic, label: 'Voice' },
  web_share: { Icon: Share2, label: 'Web share' },
};

export function IntakeSourceChip({ source }: { source: IntakeSource }) {
  const meta = SOURCE_META[source];
  if (!meta) return null;
  const { Icon, label } = meta;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
      <Icon className="size-3" />
      {label}
    </span>
  );
}
