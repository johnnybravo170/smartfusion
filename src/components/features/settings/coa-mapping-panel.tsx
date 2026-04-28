'use client';

/**
 * Bookkeeper COA upload + AI mapping review UI.
 *
 * Flow: upload CSV / XLSX → preview detected columns (override if needed)
 * → AI suggests a mapping per category → review (accept / edit / skip) →
 * apply. Nothing is persisted until the operator hits Apply.
 *
 * Onboarding philosophy: the preview step is the failsafe — if our
 * detector picks wrong columns, the user can fix it visually instead of
 * being thrown back to a "couldn't read your file" toast.
 */

import { CheckCircle2, Loader2, Paperclip, RefreshCcw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  applyCoaMappingAction,
  type CoaParsePreview,
  type CoaRow,
  type CoaSuggestion,
  parseCoaFileAction,
  runCoaMappingAction,
} from '@/server/actions/coa-mapping';

type Stage = 'upload' | 'preview' | 'mapping' | 'review';

export function CoaMappingPanel() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [stage, setStage] = useState<Stage>('upload');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Parse stage state.
  const [allRows, setAllRows] = useState<string[][]>([]);
  const [hasHeader, setHasHeader] = useState(false);
  const [preview, setPreview] = useState<CoaParsePreview | null>(null);
  const [codeIdx, setCodeIdx] = useState<number | null>(null);
  const [nameIdx, setNameIdx] = useState<number | null>(null);
  const [codeFromName, setCodeFromName] = useState(false);

  // Review stage state.
  const [accounts, setAccounts] = useState<CoaRow[]>([]);
  const [rows, setRows] = useState<(CoaSuggestion & { accepted: boolean; edited: string })[]>([]);

  function reset() {
    setStage('upload');
    setError(null);
    setAllRows([]);
    setHasHeader(false);
    setPreview(null);
    setCodeIdx(null);
    setNameIdx(null);
    setCodeFromName(false);
    setAccounts([]);
    setRows([]);
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setError(null);
    setStage('upload');

    const fd = new FormData();
    fd.append('coa', file);

    startTransition(async () => {
      const res = await parseCoaFileAction(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setAllRows(res.allRows);
      setHasHeader(res.hasHeader);
      setPreview(res.preview);
      setCodeIdx(res.preview.detectedCodeIdx);
      setNameIdx(res.preview.detectedNameIdx);
      setCodeFromName(res.preview.codeFromName);
      setStage('preview');
    });
  }

  function buildAccountsFromSelection(): CoaRow[] {
    if (nameIdx == null) return [];
    const dataRows = hasHeader ? allRows.slice(1) : allRows;
    const out: CoaRow[] = [];
    for (const r of dataRows) {
      const nameRaw = (r[nameIdx] ?? '').trim();
      if (!nameRaw) continue;
      if (codeFromName || codeIdx === -1) {
        const m = /^([0-9][\w.-]*)\s*[—–\-�]\s*(.+)$/.exec(nameRaw);
        if (m) out.push({ code: m[1].trim(), name: m[2].trim() });
        continue;
      }
      if (codeIdx == null) continue;
      const code = (r[codeIdx] ?? '').trim();
      if (code && nameRaw) out.push({ code, name: nameRaw });
    }
    return out;
  }

  function continueToMapping() {
    const acc = buildAccountsFromSelection();
    if (acc.length === 0) {
      setError("Couldn't pull any rows with the selected columns. Try changing the picks.");
      return;
    }
    setError(null);
    setAccounts(acc);
    setStage('mapping');
    startTransition(async () => {
      const res = await runCoaMappingAction({ accounts: acc });
      if (!res.ok) {
        setError(res.error);
        setStage('preview');
        return;
      }
      setRows(
        res.suggestions.map((s) => ({
          ...s,
          accepted: s.confidence === 'high' && !!s.suggestedCode,
          edited: s.suggestedCode ?? s.currentCode ?? '',
        })),
      );
      setStage('review');
    });
  }

  function toggleAccept(id: string, v: boolean) {
    setRows((prev) => prev.map((r) => (r.categoryId === id ? { ...r, accepted: v } : r)));
  }

  function setEdited(id: string, v: string) {
    setRows((prev) => prev.map((r) => (r.categoryId === id ? { ...r, edited: v } : r)));
  }

  function acceptAllHighConfidence() {
    setRows((prev) =>
      prev.map((r) => ({ ...r, accepted: r.confidence === 'high' && !!r.suggestedCode })),
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
      reset();
    });
  }

  // ---------------------------------------------------------------- upload
  if (stage === 'upload') {
    return (
      <div className="flex flex-col gap-3 rounded-md border bg-muted/10 p-4">
        <div>
          <p className="text-sm font-medium">Upload your bookkeeper&apos;s chart of accounts</p>
          <p className="text-xs text-muted-foreground">
            CSV or XLSX (QuickBooks, Xero, Sage, FreshBooks). We&apos;ll detect the columns and
            suggest a match for each category.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xlsm,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            className="hidden"
            onChange={handleUpload}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            <Paperclip className="size-3.5" />
            {pending ? 'Reading…' : 'Upload file'}
          </Button>
        </div>
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
      </div>
    );
  }

  // --------------------------------------------------------------- preview
  if (stage === 'preview' && preview) {
    return (
      <PreviewStep
        preview={preview}
        codeIdx={codeIdx}
        nameIdx={nameIdx}
        codeFromName={codeFromName}
        onPick={(kind, idx) => {
          if (kind === 'code') {
            setCodeIdx(idx);
            if (idx !== -1) setCodeFromName(false);
          } else {
            setNameIdx(idx);
          }
        }}
        onCodeFromName={(v) => {
          setCodeFromName(v);
          if (v) setCodeIdx(-1);
        }}
        onContinue={continueToMapping}
        onCancel={reset}
        pending={pending}
        error={error}
      />
    );
  }

  // --------------------------------------------------------------- mapping
  if (stage === 'mapping') {
    return (
      <div className="flex items-center gap-3 rounded-md border bg-muted/10 p-4">
        <Loader2 className="size-4 animate-spin" />
        <p className="text-sm">Asking the model to match {accounts.length} accounts…</p>
      </div>
    );
  }

  // ---------------------------------------------------------------- review
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
          <Button type="button" size="sm" variant="ghost" onClick={reset}>
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
        <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
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

function PreviewStep({
  preview,
  codeIdx,
  nameIdx,
  codeFromName,
  onPick,
  onCodeFromName,
  onContinue,
  onCancel,
  pending,
  error,
}: {
  preview: CoaParsePreview;
  codeIdx: number | null;
  nameIdx: number | null;
  codeFromName: boolean;
  onPick: (kind: 'code' | 'name', idx: number) => void;
  onCodeFromName: (v: boolean) => void;
  onContinue: () => void;
  onCancel: () => void;
  pending: boolean;
  error: string | null;
}) {
  const detectedCopy = describeDetection(preview);

  return (
    <div className="flex flex-col gap-4 rounded-md border bg-muted/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">
            Found {preview.totalRows} rows in your {preview.fileType.toUpperCase()} — {detectedCopy}
          </p>
          <p className="text-xs text-muted-foreground">
            Click a column header below to override. The code column can also be the first part of
            the name (e.g. <span className="font-mono">1010 — Cash</span>).
            {preview.encodingFallbackUsed
              ? ' (We re-decoded the file from windows-1252 to fix mojibake.)'
              : ''}
          </p>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border bg-background">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/30">
              {preview.headers.map((h, i) => {
                const isCode = codeIdx === i && !codeFromName;
                const isName = nameIdx === i;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: column index is the stable identity for this row
                  <th key={`${i}-${h}`} className="px-3 py-2 text-left font-medium">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">
                        {h || `Column ${i + 1}`}
                      </span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => onPick('code', i)}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            isCode
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-muted text-muted-foreground hover:bg-muted/70'
                          }`}
                        >
                          Code
                        </button>
                        <button
                          type="button"
                          onClick={() => onPick('name', i)}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            isName
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-muted text-muted-foreground hover:bg-muted/70'
                          }`}
                        >
                          Name
                        </button>
                      </div>
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {preview.sampleRows.map((r, ri) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: preview rows are static per upload
              <tr key={`r-${ri}`} className="border-b last:border-0">
                {preview.headers.map((_, ci) => (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: column index is the stable identity for this cell
                    key={`c-${ri}-${ci}`}
                    className={`px-3 py-1.5 align-middle ${
                      ci === codeIdx && !codeFromName
                        ? 'bg-emerald-50/40'
                        : ci === nameIdx
                          ? 'bg-blue-50/40'
                          : ''
                    }`}
                  >
                    {(r[ci] ?? '').slice(0, 60)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={codeFromName}
          onChange={(e) => onCodeFromName(e.target.checked)}
        />
        <span>
          Code is embedded inside the name column (e.g.{' '}
          <span className="font-mono">1010 — CCS Savings</span>)
        </span>
      </label>

      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      <div className="flex items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
        <Button
          type="button"
          onClick={onContinue}
          disabled={pending || nameIdx == null || (!codeFromName && codeIdx == null)}
        >
          {pending ? 'Working…' : 'Continue → Suggest mappings'}
        </Button>
      </div>
    </div>
  );
}

function describeDetection(p: CoaParsePreview): string {
  if (p.detectedNameIdx == null && p.detectedCodeIdx == null) {
    return "we couldn't auto-detect the columns — please pick them";
  }
  switch (p.detectionSource) {
    case 'header':
      return 'detected via column headers';
    case 'code-from-name':
      return 'code is embedded inside the name column';
    case 'fallback':
      return 'detected by content shape (low confidence — please verify)';
    default:
      return 'please confirm column picks';
  }
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
