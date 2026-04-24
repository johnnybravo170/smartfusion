'use client';

/**
 * "Terms & notes" editor on the estimate tab. Bound to `projects.terms_text`.
 *
 * Chip row above the textarea renders every tenant snippet as a one-click
 * insert shortcut — clicking a chip drops that snippet's body at the cursor
 * (or end of text if not focused). Freely editable after insert. On new
 * projects with empty terms_text, any `is_default` snippets auto-insert
 * the first time the editor mounts.
 *
 * Debounced autosave: 1s after last keystroke, persists via
 * patchProjectTermsTextAction.
 */

import { Check, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { EstimateSnippetRow } from '@/lib/db/queries/estimate-snippets';
import { patchProjectTermsTextAction } from '@/server/actions/estimate-snippets';

export function EstimateTermsEditor({
  projectId,
  initialTermsText,
  snippets,
}: {
  projectId: string;
  initialTermsText: string | null;
  snippets: EstimateSnippetRow[];
}) {
  const [value, setValue] = useState(() => {
    // First-time population: if the project has no terms yet, merge the
    // tenant's default snippets into a seed body so the operator lands on
    // something useful instead of an empty box.
    if (initialTermsText?.trim()) return initialTermsText;
    const defaults = snippets.filter((s) => s.is_default);
    if (defaults.length === 0) return '';
    return defaults.map((s) => s.body.trim()).join('\n\n');
  });

  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastSavedRef = useRef<string>(initialTermsText ?? '');
  // Stable ref around persist so the effects can call the latest version
  // without listing it as a dep (which would reset the timer every render).
  const persistRef = useRef<(next: string, opts?: { silent?: boolean }) => Promise<void>>(
    async () => {},
  );

  async function persist(next: string, opts?: { silent?: boolean }) {
    setSaveState('saving');
    const res = await patchProjectTermsTextAction(projectId, next);
    if (res.ok) {
      lastSavedRef.current = next;
      setSaveState('saved');
      if (!opts?.silent) {
        // Fade the "Saved" indicator after a beat.
        setTimeout(() => setSaveState('idle'), 1500);
      }
    } else {
      setSaveState('error');
      toast.error(`Terms save failed: ${res.error}`);
    }
  }

  // Keep persistRef pointing at the latest persist closure so the effects
  // can call it without declaring it as a dep.
  persistRef.current = persist;

  // Mount-only: if we pre-populated from defaults, persist that seed once
  // so the customer-facing estimate isn't blank on the first render. Reads
  // the initial values off refs so the effect genuinely has no deps and
  // only fires once.
  const seedArgsRef = useRef({ seeded: !initialTermsText?.trim(), initialValue: value });
  useEffect(() => {
    const { seeded, initialValue } = seedArgsRef.current;
    if (seeded && initialValue.trim()) {
      void persistRef.current(initialValue, { silent: true });
    }
  }, []);

  // Debounced autosave on edits. Timer resets on every keystroke; lands 1s
  // after the operator stops typing.
  useEffect(() => {
    if (value === lastSavedRef.current) return;
    const id = setTimeout(() => {
      void persistRef.current(value);
    }, 1000);
    return () => clearTimeout(id);
  }, [value]);

  function insertSnippet(body: string) {
    const el = textareaRef.current;
    const snippet = body.trim();
    if (!el) {
      setValue((prev) => (prev.trim() ? `${prev.trim()}\n\n${snippet}` : snippet));
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const needsSpaceBefore = before.length > 0 && !before.endsWith('\n\n');
    const needsSpaceAfter = after.length > 0 && !after.startsWith('\n\n');
    const prefix = needsSpaceBefore ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const suffix = needsSpaceAfter ? (after.startsWith('\n') ? '\n' : '\n\n') : '';
    const next = `${before}${prefix}${snippet}${suffix}${after}`;
    setValue(next);
    // Put the cursor right after the inserted block so the next insert lands
    // in a sensible place.
    requestAnimationFrame(() => {
      if (!textareaRef.current) return;
      const caret = before.length + prefix.length + snippet.length;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(caret, caret);
    });
  }

  return (
    <section className="rounded-xl border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-5 py-3">
        <div>
          <h2 className="text-sm font-semibold">Terms &amp; notes</h2>
          <p className="text-xs text-muted-foreground">
            Appears at the bottom of the customer-facing estimate. Autosaves.
          </p>
        </div>
        <SaveIndicator state={saveState} />
      </header>

      <div className="flex flex-col gap-3 p-5">
        {snippets.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {snippets.map((s) => (
              <Button
                key={s.id}
                type="button"
                size="xs"
                variant="outline"
                onClick={() => insertSnippet(s.body)}
                title={s.body}
              >
                + {s.label}
              </Button>
            ))}
            <Button type="button" size="xs" variant="ghost" asChild>
              <Link href="/settings/estimate-snippets">Manage snippets</Link>
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            No snippets in your library yet.{' '}
            <Link
              href="/settings/estimate-snippets"
              className="text-foreground underline hover:text-primary"
            >
              Add some in settings
            </Link>{' '}
            so they show up here as one-click chips.
          </p>
        )}

        <Textarea
          ref={textareaRef}
          rows={10}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Anything worth saying alongside the estimate — scope assumptions, exclusions, warranty, deposit terms, etc."
        />
      </div>
    </section>
  );
}

function SaveIndicator({ state }: { state: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (state === 'saving') {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" />
        Saving…
      </span>
    );
  }
  if (state === 'saved') {
    return (
      <span className="flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
        <Check className="size-3" />
        Saved
      </span>
    );
  }
  if (state === 'error') {
    return <span className="text-xs text-destructive">Save failed</span>;
  }
  return null;
}
