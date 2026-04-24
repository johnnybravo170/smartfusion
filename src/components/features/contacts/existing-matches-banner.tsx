'use client';

/**
 * Shared dedup banner for every contact-create surface.
 *
 * Two visual tiers based on match strength:
 *   - Any strong match (phone / email / exact name) → amber banner,
 *     firmer copy, "Create anyway" escape framed as the non-default.
 *   - Weak only (fuzzy name similarity) → blue banner, FYI copy,
 *     "This is someone different, create" as a first-class button
 *     (two different people can legitimately share a name).
 *
 * Either way the operator can pick an existing candidate from the list.
 */

import { Button } from '@/components/ui/button';
import type { ContactMatch } from '@/lib/db/queries/contact-matches-types';
import { cn } from '@/lib/utils';

const MATCHED_ON_LABEL: Record<ContactMatch['matchedOn'], string> = {
  phone: 'Same phone',
  email: 'Same email',
  name: 'Same name',
  similar_name: 'Similar name',
};

export function ExistingMatchesBanner({
  matches,
  onUseExisting,
  onCreateAnyway,
  useLabel,
  createLabel,
}: {
  matches: ContactMatch[];
  onUseExisting?: (contactId: string) => void;
  onCreateAnyway?: () => void;
  useLabel?: string;
  createLabel?: string;
}) {
  if (matches.length === 0) return null;
  const strong = matches.some((m) => m.strength === 'strong');

  const headline = strong
    ? `Looks like ${matches.length === 1 ? 'this contact' : 'these contacts'} already ${matches.length === 1 ? 'exists' : 'exist'}.`
    : `You already have ${matches.length === 1 ? 'a contact' : 'contacts'} with a similar name — is this the same person?`;

  const defaultUseLabel = strong ? 'Use this contact' : 'Yes, use this one';
  const defaultCreateLabel = strong
    ? 'Create anyway'
    : 'No, this is someone different — create new';

  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        strong
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100'
          : 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-700 dark:bg-sky-950/40 dark:text-sky-100',
      )}
    >
      <p className="text-sm font-medium">{headline}</p>
      <ul className="mt-2 space-y-2">
        {matches.map((m) => (
          <li
            key={m.id}
            className="flex items-center justify-between gap-3 rounded-md bg-white/60 px-3 py-2 text-sm dark:bg-black/20"
          >
            <div className="flex flex-col">
              <span className="font-medium">{m.name}</span>
              <span
                className={cn(
                  'text-xs',
                  strong ? 'text-amber-800 dark:text-amber-200' : 'text-sky-800 dark:text-sky-200',
                )}
              >
                {m.kind} · {MATCHED_ON_LABEL[m.matchedOn]}
                {m.similarity !== undefined ? ` (${Math.round(m.similarity * 100)}%)` : ''}
                {m.phone ? ` · ${m.phone}` : ''}
                {m.email ? ` · ${m.email}` : ''}
              </span>
            </div>
            {onUseExisting ? (
              <Button type="button" size="xs" variant="outline" onClick={() => onUseExisting(m.id)}>
                {useLabel ?? defaultUseLabel}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {onCreateAnyway ? (
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            size="xs"
            variant={strong ? 'ghost' : 'outline'}
            onClick={onCreateAnyway}
          >
            {createLabel ?? defaultCreateLabel}
          </Button>
        </div>
      ) : (
        <p
          className={cn(
            'mt-2 text-xs',
            strong ? 'text-amber-800 dark:text-amber-200' : 'text-sky-800 dark:text-sky-200',
          )}
        >
          Or keep going below to create a brand-new contact.
        </p>
      )}
    </div>
  );
}
