'use client';

/**
 * Bookkeeper COA upload + AI mapping review UI.
 *
 * Flow: upload CSV → see AI-suggested mapping per category → review
 * (accept / edit / skip) → apply. Nothing is persisted until the
 * operator hits Apply.
 */

import { CheckCircle2, Paperclip, RefreshCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  analyzeCoaAction,
  applyCoaMappingAction,
  type CoaSuggestion,
} from '@/server/actions/coa-mapping';

export function CoaMappingPanel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [accounts, setAccounts] = useState<{ code: string; name: string }[] | null>(null);
  const [rows, setRows] = useState<(CoaSuggestion & { accepted: boolean; edited: string })[]>([]);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setUploading(true);
    setError(null);
    const fd = new FormData();
    fd.append('coa', file);
    const res = await analyzeCoaAction(fd);
    setUploading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setAccounts(res.accounts);
    setRows(
      res.suggestions.map((s) => ({
        ...s,
        // Auto-accept high-confidence + default the editable code field
        // to the AI suggestion (or current if already set).
        accepted: s.confidence === 'high' && !!s.suggestedCode,
        edited: s.suggestedCode ?? s.currentCode ?? '',
      })),
    );
  }

  function toggleAccept(id: string, v: boolean) {
    setRows((prev) => prev.map((r) => (r.categoryId === id ? { ...r, accepted: v } : r)));
  }

  function setEdited(id: string, v: string) {
    setRows((prev) => prev.map((r) => (r.categoryId === id ? { ...r, edited: v } : r)));
  }

  function acceptAllHighConfidence() {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        accepted: r.confidence === 'high' && !!r.suggestedCode,
      })),
    );
  }

  function applyAccepted() {
    const mappings = rows
      .filter((r) => r.accepted)
      .map((r) => ({ category_id: r.categoryId, account_code: r.edited.trim() || null }));
    if (mappings.length === 0) {
      toast.error('Nothing accepted — check at least one row.');
      return;
    }
    startTransition(async () => {
      const res = await applyCoaMappingAction({ mappings });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Applied ${res.updated} mapping${res.updated === 1 ? '' : 's'}.`);
      router.refresh();
      // Reset state so a second upload starts fresh.
      setAccounts(null);
      setRows([]);
    });
  }

  if (!accounts) {
    return (
      <div className="flex flex-col gap-3 rounded-md border bg-muted/10 p-4">
        <div>
          <p className="text-sm font-medium">Upload your bookkeeper&apos;s chart of accounts</p>
          <p className="text-xs text-muted-foreground">
            CSV with code + name columns (from QBO, Xero, Sage). We&apos;ll suggest a match for each
            category.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={handleUpload}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading}
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip className="size-3.5" />
            {uploading ? 'Reading…' : 'Upload CSV'}
          </Button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    );
  }

  const acceptedCount = rows.filter((r) => r.accepted).length;
  const highCount = rows.filter((r) => r.confidence === 'high').length;

  return (
    <div className="flex flex-col gap-4 rounded-md border bg-muted/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            Found {accounts.length} accounts — review suggested mappings
          </p>
          <p className="text-xs text-muted-foreground">
            {highCount} high-confidence · {acceptedCount} accepted
          </p>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="outline" onClick={acceptAllHighConfidence}>
            <CheckCircle2 className="size-3.5" />
            Accept all high
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAccounts(null)}>
            <RefreshCcw className="size-3.5" />
            Upload different file
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="w-8 px-2 py-2" aria-label="Accept" />
              <th className="px-3 py-2 text-left font-medium">Category</th>
              <th className="px-3 py-2 text-left font-medium">Suggested</th>
              <th className="w-32 px-3 py-2 text-left font-medium">Code</th>
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Why</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.categoryId} className="border-b last:border-0">
                <td className="px-2 py-2 align-middle">
                  <input
                    type="checkbox"
                    checked={r.accepted}
                    onChange={(e) => toggleAccept(r.categoryId, e.target.checked)}
                    aria-label={`Accept ${r.categoryLabel}`}
                  />
                </td>
                <td className="px-3 py-2 align-middle">{r.categoryLabel}</td>
                <td className="px-3 py-2 align-middle">
                  {r.suggestedCode ? (
                    <span>
                      <span className="font-medium">{r.suggestedCode}</span>{' '}
                      <span className="text-muted-foreground">— {r.suggestedName}</span>{' '}
                      {r.confidence ? <ConfidenceBadge c={r.confidence} /> : null}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">— no match —</span>
                  )}
                </td>
                <td className="px-3 py-2 align-middle">
                  <Input
                    value={r.edited}
                    onChange={(e) => setEdited(r.categoryId, e.target.value)}
                    className="h-8 text-sm"
                    placeholder="—"
                  />
                </td>
                <td className="px-3 py-2 align-middle text-xs text-muted-foreground">
                  {r.reason ?? ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => setAccounts(null)} disabled={pending}>
          Cancel
        </Button>
        <Button type="button" onClick={applyAccepted} disabled={pending || acceptedCount === 0}>
          {pending
            ? 'Applying…'
            : `Apply ${acceptedCount} mapping${acceptedCount === 1 ? '' : 's'}`}
        </Button>
      </div>
    </div>
  );
}

function ConfidenceBadge({ c }: { c: 'high' | 'medium' | 'low' }) {
  const className =
    c === 'high'
      ? 'bg-emerald-100 text-emerald-700'
      : c === 'medium'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-gray-100 text-gray-600';
  return (
    <span className={`ml-1 inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      {c}
    </span>
  );
}
