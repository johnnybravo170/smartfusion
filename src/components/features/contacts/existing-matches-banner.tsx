'use client';

/**
 * Shared amber "looks like this exists" banner shown on every contact-create
 * surface (intake review, manual form, inline picker-create, customer-lead
 * accept). The create actions short-circuit when they find duplicates and
 * return them here; the form renders this banner with per-candidate "Use
 * this contact" actions and a "Create anyway" escape.
 */

import { Button } from '@/components/ui/button';
import type { ContactMatch } from '@/lib/db/queries/contact-matches';

const MATCHED_ON_LABEL: Record<ContactMatch['matchedOn'], string> = {
  phone: 'Same phone',
  email: 'Same email',
  name: 'Same name',
};

export function ExistingMatchesBanner({
  matches,
  onUseExisting,
  onCreateAnyway,
  useLabel = 'Use this contact',
  createLabel = 'Create anyway',
}: {
  matches: ContactMatch[];
  onUseExisting?: (contactId: string) => void;
  onCreateAnyway?: () => void;
  useLabel?: string;
  createLabel?: string;
}) {
  if (matches.length === 0) return null;
  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
      <p className="text-sm font-medium">
        Looks like {matches.length === 1 ? 'this contact' : 'these contacts'} might already exist.
      </p>
      <ul className="mt-2 space-y-2">
        {matches.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between gap-3 rounded-md bg-white/60 px-3 py-2 text-sm dark:bg-black/20"
          >
            <div className="flex flex-col">
              <span className="font-medium">{m.name}</span>
              <span className="text-xs text-amber-800 dark:text-amber-200">
                {m.kind} · {MATCHED_ON_LABEL[m.matchedOn]}
                {m.phone ? ` · ${m.phone}` : ''}
                {m.email ? ` · ${m.email}` : ''}
              </span>
            </div>
            {onUseExisting ? (
              <Button type="button" size="xs" variant="outline" onClick={() => onUseExisting(m.id)}>
                {useLabel}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {onCreateAnyway ? (
        <div className="mt-3 flex justify-end">
          <Button type="button" size="xs" variant="ghost" onClick={onCreateAnyway}>
            {createLabel}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
          Or keep going below to create a brand-new contact.
        </p>
      )}
    </div>
  );
}
