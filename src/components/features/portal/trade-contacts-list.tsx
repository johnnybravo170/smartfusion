/**
 * Read-only "Trade contacts" list — the sub-trades and vendors that
 * worked on this project. Pulled from project_documents.supplier_id
 * via listSubcontractorsForProject. Same component renders on the
 * operator Documents tab and the homeowner portal.
 *
 * Server component, no client JS.
 */

import { Mail, Phone, Wrench } from 'lucide-react';
import type { ProjectSubContact } from '@/lib/db/queries/project-documents';

const KIND_LABEL: Partial<Record<ProjectSubContact['kind'], string>> = {
  sub: 'Sub-trade',
  vendor: 'Vendor',
};

export function TradeContactsList({
  contacts,
  heading = 'Trade contacts',
}: {
  contacts: ProjectSubContact[];
  heading?: string;
}) {
  if (contacts.length === 0) return null;
  return (
    <section className="rounded-lg border bg-card">
      <div className="flex items-center gap-2 border-b px-4 py-2">
        <Wrench className="size-4 text-muted-foreground" aria-hidden />
        <h3 className="text-sm font-semibold">{heading}</h3>
        <span className="ml-auto text-xs text-muted-foreground">{contacts.length}</span>
      </div>
      <ul className="divide-y">
        {contacts.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{c.name}</p>
              {KIND_LABEL[c.kind] ? (
                <p className="text-[11px] text-muted-foreground">{KIND_LABEL[c.kind]}</p>
              ) : null}
            </div>
            {c.phone ? (
              <a
                href={`tel:${c.phone}`}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Phone className="size-3.5" aria-hidden />
                {c.phone}
              </a>
            ) : null}
            {c.email ? (
              <a
                href={`mailto:${c.email}`}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <Mail className="size-3.5" aria-hidden />
                {c.email}
              </a>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
