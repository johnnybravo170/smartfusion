'use client';

/**
 * Bulk receipt import wizard. Phase D.
 *
 * Different shape from A/B/C: input is a pile of files, parsing
 * happens on the client by fanning out to a single-file server action
 * for each one. The wizard shows live progress as receipts come back
 * (and surface errors per-file rather than failing the whole batch).
 *
 * Three stages:
 *   1. INPUT — drop the files. "Read them" kicks off the client fan-out.
 *   2. PROCESSING — per-file progress; rows render as they parse.
 *   3. PREVIEW — the full set, editable. Operator clicks "Bring them in"
 *      → commitReceiptImportAction inserts the whole batch.
 *   4. DONE — counts.
 */

import { ArrowRight, Check, FileText, Loader2, Sparkles, Tag, Upload, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { IntakeDropzone } from '@/components/features/contacts/intake-dropzone';
import {
  LabelCardDialog,
  type LabelCardResult,
} from '@/components/features/payment-sources/label-card-dialog';
import { PaymentSourcePill } from '@/components/features/payment-sources/payment-source-pill';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { PaymentSourceLite } from '@/lib/db/queries/payment-sources';
import { compressReceiptIfImage, withTimeout } from '@/lib/storage/resize-image';
import {
  type CategoryPickerOptionLite,
  type CommitReceiptImportRow,
  commitReceiptImportAction,
  dedupReceiptProposalsAction,
  type ProposedReceiptExpense,
  parseReceiptForImportAction,
} from '@/server/actions/onboarding-import-receipts';

/** Per-file OCR timeout. The fan-out loop is sequential, so a single
 *  hung receipt would otherwise stall the whole batch. 30s matches the
 *  single-receipt forms. */
const PER_FILE_OCR_TIMEOUT_MS = 30_000;

type Stage = 'input' | 'processing' | 'preview' | 'done';

type RowState = ProposedReceiptExpense & {
  rowKey: string;
  decision: 'create' | 'merge' | 'skip';
  match: { tier: string | null; label: string; existingId: string | null };
  parseError?: string;
};

const ADD_NEW_SOURCE_SENTINEL = '__add_new_source__';

export function ReceiptImportWizard() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('input');
  const [pending, startTransition] = useTransition();

  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<RowState[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, errors: 0 });
  const [note, setNote] = useState('');
  const [categories, setCategories] = useState<CategoryPickerOptionLite[]>([]);
  const [paymentSources, setPaymentSources] = useState<PaymentSourceLite[]>([]);
  const [labelCardFor, setLabelCardFor] = useState<{
    last4: string;
    rowKey: string;
    network: PaymentSourceLite['kind'] | null;
  } | null>(null);

  const [doneCounts, setDoneCounts] = useState<{
    created: number;
    merged: number;
    skipped: number;
    batchId: string;
  } | null>(null);

  // ── Stage 1 → 2: parse ─────────────────────────────────────────────────

  async function handleParse() {
    if (files.length === 0) {
      toast.error('Drop some receipts first.');
      return;
    }
    setStage('processing');
    setRows([]);
    setProgress({ done: 0, total: files.length, errors: 0 });

    const proposals: RowState[] = [];
    let errors = 0;

    // Sequential fan-out. Could parallelize (e.g. 3 at a time) but
    // sequential keeps the UX predictable and avoids hammering the
    // gateway. Receipt OCR is the throttling concern, not throughput.
    for (let i = 0; i < files.length; i++) {
      // Compress images right before upload — 20 phone-camera receipts
      // would otherwise push 100MB+ through one server-action queue.
      // PDFs and decode failures pass through unchanged.
      const file = await compressReceiptIfImage(files[i]);
      const fd = new FormData();
      fd.set('file', file);
      let res: Awaited<ReturnType<typeof parseReceiptForImportAction>>;
      try {
        res = await withTimeout(parseReceiptForImportAction(fd), PER_FILE_OCR_TIMEOUT_MS);
      } catch (err) {
        // One thrown call (network / function timeout) used to freeze the
        // whole batch on the processing stage. Treat it like a parse error
        // so the loop continues and the operator can retry that file.
        console.error('parseReceiptForImportAction failed', err);
        res = {
          ok: false,
          error:
            err instanceof Error && err.name === 'TimeoutError'
              ? 'Receipt timed out — retry this one.'
              : 'Could not read this receipt.',
          filename: file.name,
        };
      }
      if (res.ok) {
        // Categories + payment sources come back identical on every
        // successful parse. Capture once on the first hit so the picker
        // is ready for operator overrides as the rest stream in.
        if (categories.length === 0 && res.categories.length > 0) {
          setCategories(res.categories);
        }
        if (paymentSources.length === 0 && res.paymentSources.length > 0) {
          setPaymentSources(res.paymentSources);
        }
        const row: RowState = {
          ...res.proposed,
          rowKey: `r${i}`,
          decision: 'create',
          match: { tier: null, label: '', existingId: null },
        };
        proposals.push(row);
        setRows((prev) => [...prev, row]);
      } else {
        errors += 1;
        // Stash a failed row so the operator sees what didn't read.
        const row: RowState = {
          rowKey: `r${i}`,
          filename: res.filename || file.name,
          storagePath: '',
          amountCents: null,
          preTaxAmountCents: null,
          taxCents: null,
          vendor: null,
          vendorGstNumber: null,
          expenseDateIso: null,
          description: null,
          categoryId: null,
          categoryLabel: null,
          cardLast4: null,
          cardNetwork: null,
          paymentSourceId: null,
          paymentSourceResolution: 'none',
          decision: 'skip',
          match: { tier: null, label: '', existingId: null },
          parseError: res.error,
        };
        proposals.push(row);
        setRows((prev) => [...prev, row]);
      }
      setProgress({ done: i + 1, total: files.length, errors });
    }

    // After all OCRs, single round-trip for dedup hints.
    const dedupRes = await dedupReceiptProposalsAction(
      proposals
        .filter((p) => !p.parseError)
        .map((p) => ({
          filename: p.filename,
          vendor: p.vendor,
          amountCents: p.amountCents,
          taxCents: p.taxCents,
          expenseDateIso: p.expenseDateIso,
        })),
    );
    if (dedupRes.ok) {
      const hintByFilename = new Map(dedupRes.hints.map((h) => [h.filename, h.match]));
      setRows((prev) =>
        prev.map((r) => {
          const hit = hintByFilename.get(r.filename);
          if (!hit) return r;
          return {
            ...r,
            match: { tier: hit.tier ?? null, label: hit.label, existingId: hit.existingId },
            decision: hit.tier ? 'merge' : r.decision,
          };
        }),
      );
    }

    setStage('preview');
  }

  // ── Stage 3: commit ────────────────────────────────────────────────────

  function handleCommit() {
    const commitRows: CommitReceiptImportRow[] = rows
      .filter((r) => !r.parseError)
      .map((r) => ({
        filename: r.filename,
        storagePath: r.storagePath,
        decision: r.decision,
        amountCents: r.amountCents,
        preTaxAmountCents: r.preTaxAmountCents,
        taxCents: r.taxCents,
        vendor: r.vendor,
        vendorGstNumber: r.vendorGstNumber,
        expenseDateIso: r.expenseDateIso,
        description: r.description,
        categoryId: r.categoryId,
        paymentSourceId: r.paymentSourceId,
        cardLast4: r.cardLast4,
      }));
    startTransition(async () => {
      const res = await commitReceiptImportAction({
        rows: commitRows,
        note: note.trim() || null,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setDoneCounts({
        created: res.created,
        merged: res.merged,
        skipped: res.skipped,
        batchId: res.batchId,
      });
      setStage('done');
      router.refresh();
    });
  }

  function handleReset() {
    setStage('input');
    setFiles([]);
    setRows([]);
    setProgress({ done: 0, total: 0, errors: 0 });
    setNote('');
    setDoneCounts(null);
  }

  function updateRow(rowKey: string, updater: (r: RowState) => RowState) {
    setRows((prev) => prev.map((r) => (r.rowKey === rowKey ? updater(r) : r)));
  }

  /**
   * Apply a freshly-labeled card to every sibling row in this batch
   * that paid with the same last4. The whole point of the dialog —
   * label once, splice everywhere.
   */
  function handleCardLabeled(saved: LabelCardResult) {
    setPaymentSources((prev) => {
      const without = prev.filter((p) => p.id !== saved.id);
      return [
        ...without,
        {
          id: saved.id,
          label: saved.label,
          last4: saved.last4,
          kind: saved.kind,
          paid_by: saved.paid_by,
          is_default: false,
        },
      ];
    });
    setRows((prev) =>
      prev.map((r) => {
        if (r.cardLast4 !== saved.last4) return r;
        return { ...r, paymentSourceId: saved.id, paymentSourceResolution: 'matched_card' };
      }),
    );
    const matched = rows.filter((r) => r.cardLast4 === saved.last4).length;
    toast.success(
      matched > 1
        ? `Tagged ${matched} receipts with ${saved.label}.`
        : `Saved card ${saved.label}.`,
    );
    setLabelCardFor(null);
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (stage === 'input') {
    return <InputStage files={files} setFiles={setFiles} onParse={handleParse} />;
  }
  if (stage === 'processing') {
    return <ProcessingStage progress={progress} rows={rows} />;
  }
  if (stage === 'preview') {
    return (
      <>
        <PreviewStage
          rows={rows}
          updateRow={updateRow}
          categories={categories}
          paymentSources={paymentSources}
          onLabelCard={(rowKey, last4) => setLabelCardFor({ rowKey, last4, network: null })}
          progress={progress}
          note={note}
          setNote={setNote}
          pending={pending}
          onCommit={handleCommit}
          onBack={handleReset}
        />
        {labelCardFor ? (
          <LabelCardDialog
            open
            onOpenChange={(v) => {
              if (!v) setLabelCardFor(null);
            }}
            last4={labelCardFor.last4}
            onSaved={handleCardLabeled}
          />
        ) : null}
      </>
    );
  }
  return <DoneStage counts={doneCounts} onAnother={handleReset} />;
}

// ── Stage 1: input ─────────────────────────────────────────────────────────

function InputStage({
  files,
  setFiles,
  onParse,
}: {
  files: File[];
  setFiles: (f: File[]) => void;
  onParse: () => void;
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border bg-card p-5">
        <p className="mb-3 text-sm font-medium">Drop a stack of receipts</p>
        <IntakeDropzone
          files={files}
          onFilesAdded={(f) => setFiles([...files, ...f])}
          onRemove={(i) => setFiles(files.filter((_, idx) => idx !== i))}
          accept=".pdf,application/pdf,image/*"
          multiple
          hint="PDFs and images. Drop as many as you want — Henry handles them one at a time."
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {files.length === 0
            ? 'Nothing dropped yet.'
            : `${files.length} ${files.length === 1 ? 'receipt' : 'receipts'} ready.`}
        </p>
        <Button onClick={onParse} disabled={files.length === 0}>
          <Sparkles className="size-3.5" />
          Read them
        </Button>
      </div>
    </div>
  );
}

// ── Stage 2: processing ────────────────────────────────────────────────────

function ProcessingStage({
  progress,
  rows,
}: {
  progress: { done: number; total: number; errors: number };
  rows: RowState[];
}) {
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Loader2 className="size-4 animate-spin" />
            Reading receipt {progress.done} of {progress.total}…
          </div>
          {progress.errors > 0 ? (
            <Badge variant="outline" className="border-red-300 text-red-700">
              {progress.errors} couldn&rsquo;t read
            </Badge>
          ) : null}
        </div>
        <div
          className="mt-3 h-2 w-full overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${pct}% done`}
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {rows.length > 0 ? (
        <ul className="flex flex-col gap-1.5 rounded-xl border bg-card p-3 text-xs">
          {rows.slice(-12).map((r) => (
            <li key={r.rowKey} className="flex items-center gap-2">
              <FileText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate" title={r.filename}>
                {r.filename}
              </span>
              {r.parseError ? (
                <span className="flex shrink-0 items-center gap-1 text-red-700">
                  <X className="size-3" /> {r.parseError}
                </span>
              ) : (
                <span className="shrink-0 text-muted-foreground tabular-nums">
                  {r.vendor ?? '—'} ·{' '}
                  {r.amountCents !== null ? `$${(r.amountCents / 100).toFixed(2)}` : '—'}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ── Stage 3: preview ───────────────────────────────────────────────────────

function PreviewStage({
  rows,
  updateRow,
  categories,
  paymentSources,
  onLabelCard,
  progress,
  note,
  setNote,
  pending,
  onCommit,
  onBack,
}: {
  rows: RowState[];
  updateRow: (rowKey: string, updater: (r: RowState) => RowState) => void;
  categories: CategoryPickerOptionLite[];
  paymentSources: PaymentSourceLite[];
  onLabelCard: (rowKey: string, last4: string) => void;
  progress: { done: number; total: number; errors: number };
  note: string;
  setNote: (v: string) => void;
  pending: boolean;
  onCommit: () => void;
  onBack: () => void;
}) {
  const counts = {
    create: rows.filter((r) => r.decision === 'create' && !r.parseError).length,
    merge: rows.filter((r) => r.decision === 'merge' && !r.parseError).length,
    skip: rows.filter((r) => r.decision === 'skip' || r.parseError).length,
    missingMoney: rows.filter(
      (r) =>
        !r.parseError && r.decision === 'create' && (r.amountCents === null || !r.expenseDateIso),
    ).length,
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            Henry read {progress.total - progress.errors} of {progress.total}
          </span>
          {progress.errors > 0 ? (
            <span className="text-xs text-red-700">
              {progress.errors} couldn&rsquo;t parse — see the rows below
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary">{counts.create} new</Badge>
          {counts.merge > 0 ? <Badge variant="secondary">{counts.merge} merged</Badge> : null}
          {counts.skip > 0 ? <Badge variant="outline">{counts.skip} skipped</Badge> : null}
          {counts.missingMoney > 0 ? (
            <Badge variant="outline" className="border-red-400 text-red-700">
              {counts.missingMoney} missing money
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">File</th>
              <th className="px-3 py-2 text-left font-medium">Vendor</th>
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 text-right font-medium">Tax</th>
              <th className="px-3 py-2 text-left font-medium">Category</th>
              <th className="px-3 py-2 text-left font-medium">Paid by</th>
              <th className="px-3 py-2 text-left font-medium">Match</th>
              <th className="px-3 py-2 text-right font-medium">Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.rowKey}
                className={`border-b last:border-0 ${
                  r.parseError || r.decision === 'skip' ? 'opacity-60' : ''
                }`}
              >
                <td className="px-3 py-2 align-top">
                  <p className="truncate text-xs font-medium" title={r.filename}>
                    {r.filename}
                  </p>
                  {r.parseError ? (
                    <p className="text-xs text-red-700">{r.parseError}</p>
                  ) : r.description ? (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{r.description}</p>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top">
                  <Input
                    value={r.vendor ?? ''}
                    placeholder="—"
                    onChange={(e) =>
                      updateRow(r.rowKey, (row) => ({ ...row, vendor: e.target.value || null }))
                    }
                    className="h-8 border-transparent bg-transparent px-1 hover:border-input focus:border-input"
                    disabled={pending || !!r.parseError}
                  />
                </td>
                <td className="px-3 py-2 align-top">
                  <input
                    type="date"
                    value={r.expenseDateIso ?? ''}
                    onChange={(e) =>
                      updateRow(r.rowKey, (row) => ({
                        ...row,
                        expenseDateIso: e.target.value || null,
                      }))
                    }
                    disabled={pending || !!r.parseError}
                    className="rounded border-transparent bg-transparent px-1 text-xs hover:border-input focus:border-input"
                  />
                </td>
                <MoneyCell
                  cents={r.amountCents}
                  onChange={(c) =>
                    updateRow(r.rowKey, (row) => ({
                      ...row,
                      amountCents: c,
                      // Operator-edited total invalidates the OCR'd pre-tax;
                      // re-derive from tax if we still have it, else null
                      // and let cost-plus markup fall back to amount_cents.
                      preTaxAmountCents:
                        c !== null && row.taxCents !== null && row.taxCents <= c
                          ? c - row.taxCents
                          : null,
                    }))
                  }
                  disabled={pending || !!r.parseError}
                />
                <MoneyCell
                  cents={r.taxCents}
                  onChange={(c) =>
                    updateRow(r.rowKey, (row) => ({
                      ...row,
                      taxCents: c,
                      preTaxAmountCents:
                        row.amountCents !== null && c !== null && c <= row.amountCents
                          ? row.amountCents - c
                          : null,
                    }))
                  }
                  disabled={pending || !!r.parseError}
                />
                <td className="px-3 py-2 align-top">
                  <CategoryCell
                    row={r}
                    categories={categories}
                    onChange={(id, label) =>
                      updateRow(r.rowKey, (row) => ({
                        ...row,
                        categoryId: id,
                        categoryLabel: label,
                      }))
                    }
                    disabled={pending || !!r.parseError}
                  />
                </td>
                <td className="px-3 py-2 align-top">
                  <SourceCell
                    row={r}
                    paymentSources={paymentSources}
                    onPick={(id) =>
                      updateRow(r.rowKey, (row) => ({
                        ...row,
                        paymentSourceId: id,
                        paymentSourceResolution: id ? 'matched_card' : 'none',
                      }))
                    }
                    onLabelCard={() => {
                      if (r.cardLast4) onLabelCard(r.rowKey, r.cardLast4);
                    }}
                    disabled={pending || !!r.parseError}
                  />
                </td>
                <td className="px-3 py-2 align-top">
                  {r.match.tier ? (
                    <span className="text-xs text-amber-700">{r.match.label}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground">New</span>
                  )}
                </td>
                <td className="px-3 py-2 align-top text-right">
                  <DecisionToggle
                    value={r.decision}
                    hasMatch={r.match.tier !== null}
                    disabled={pending || !!r.parseError}
                    onChange={(v) => updateRow(r.rowKey, (row) => ({ ...row, decision: v }))}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note" className="text-sm font-medium">
            Note for the audit trail{' '}
            <span className="font-normal text-muted-foreground">(optional)</span>
          </Label>
          <Input
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. 2025 receipts pile"
            disabled={pending}
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={onBack} disabled={pending}>
            Start over
          </Button>
          <Button
            onClick={onCommit}
            disabled={pending || counts.create + counts.merge === 0 || counts.missingMoney > 0}
          >
            {pending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                Bring them in
                <ArrowRight className="size-3.5" />
              </>
            )}
          </Button>
        </div>
        {counts.missingMoney > 0 ? (
          <p className="text-xs text-red-700">
            Fill in the missing amount or date on {counts.missingMoney} row
            {counts.missingMoney === 1 ? '' : 's'} (or skip them) before committing.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function MoneyCell({
  cents,
  onChange,
  disabled,
}: {
  cents: number | null;
  onChange: (c: number | null) => void;
  disabled: boolean;
}) {
  const value = cents === null ? '' : (cents / 100).toFixed(2);
  return (
    <td className="px-3 py-2 align-top text-right">
      <input
        type="number"
        step="0.01"
        value={value}
        onChange={(e) => {
          const v = e.target.value.trim();
          if (!v) {
            onChange(null);
            return;
          }
          const n = Number(v);
          onChange(Number.isFinite(n) ? Math.round(n * 100) : null);
        }}
        disabled={disabled}
        placeholder="—"
        className="w-20 rounded border-transparent bg-transparent px-1 text-right text-xs tabular-nums hover:border-input focus:border-input"
      />
    </td>
  );
}

function CategoryCell({
  row,
  categories,
  onChange,
  disabled,
}: {
  row: RowState;
  categories: CategoryPickerOptionLite[];
  onChange: (id: string | null, label: string | null) => void;
  disabled: boolean;
}) {
  const labelById = new Map(categories.map((c) => [c.id, c.label]));
  const isHenrySuggestion =
    row.categoryId !== null && row.categoryLabel !== null && !!row.categoryId;
  return (
    <div className="flex flex-col gap-0.5">
      <select
        value={row.categoryId ?? ''}
        onChange={(e) => {
          const id = e.target.value || null;
          onChange(id, id ? (labelById.get(id) ?? null) : null);
        }}
        disabled={disabled || categories.length === 0}
        className="h-7 rounded border-transparent bg-transparent px-1 text-xs hover:border-input focus:border-input disabled:opacity-50"
      >
        <option value="">— uncategorized —</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id} disabled={c.isParentHeader}>
            {c.label}
          </option>
        ))}
      </select>
      {isHenrySuggestion ? (
        <span className="px-1 text-[10px] text-muted-foreground">Suggested by Henry</span>
      ) : null}
    </div>
  );
}

function SourceCell({
  row,
  paymentSources,
  onPick,
  onLabelCard,
  disabled,
}: {
  row: RowState;
  paymentSources: PaymentSourceLite[];
  onPick: (id: string | null) => void;
  onLabelCard: () => void;
  disabled: boolean;
}) {
  const sourceById = new Map(paymentSources.map((s) => [s.id, s]));
  const selected = row.paymentSourceId ? sourceById.get(row.paymentSourceId) : undefined;

  // Card was OCR'd but not registered yet → "Label this card" affordance.
  const unknownCard = row.cardLast4 !== null && row.paymentSourceResolution === 'unknown_card';

  return (
    <div className="flex flex-col gap-1">
      {selected ? (
        <PaymentSourcePill source={selected} size="xs" />
      ) : unknownCard ? (
        <button
          type="button"
          onClick={onLabelCard}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          title={`OCR saw last 4 ${row.cardLast4} but no card with that number is labeled yet.`}
        >
          <Tag className="size-3" />
          Label ····{row.cardLast4}
        </button>
      ) : (
        <span className="text-xs text-muted-foreground">— pick —</span>
      )}
      <select
        value={row.paymentSourceId === ADD_NEW_SOURCE_SENTINEL ? '' : (row.paymentSourceId ?? '')}
        onChange={(e) => {
          const v = e.target.value;
          if (v === ADD_NEW_SOURCE_SENTINEL) {
            onLabelCard();
            return;
          }
          onPick(v || null);
        }}
        disabled={disabled || paymentSources.length === 0}
        className="h-6 rounded border-transparent bg-transparent px-1 text-[11px] text-muted-foreground hover:border-input focus:border-input disabled:opacity-50"
      >
        <option value="">— change source —</option>
        {paymentSources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
            {s.last4 ? ` ····${s.last4}` : ''}
          </option>
        ))}
        {row.cardLast4 ? (
          <option value={ADD_NEW_SOURCE_SENTINEL}>+ Label ····{row.cardLast4}…</option>
        ) : null}
      </select>
    </div>
  );
}

function DecisionToggle({
  value,
  hasMatch,
  disabled,
  onChange,
}: {
  value: 'create' | 'merge' | 'skip';
  hasMatch: boolean;
  disabled: boolean;
  onChange: (v: 'create' | 'merge' | 'skip') => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border text-xs">
      <button
        type="button"
        onClick={() => onChange('create')}
        disabled={disabled}
        className={`px-2 py-1 ${value === 'create' ? 'bg-primary text-primary-foreground' : 'bg-transparent hover:bg-muted'}`}
      >
        Create
      </button>
      <button
        type="button"
        onClick={() => onChange('merge')}
        disabled={disabled || !hasMatch}
        title={
          hasMatch ? 'Skip the insert; receipt already exists.' : 'No probable duplicate found'
        }
        className={`border-l px-2 py-1 ${
          value === 'merge'
            ? 'bg-primary text-primary-foreground'
            : hasMatch
              ? 'bg-transparent hover:bg-muted'
              : 'cursor-not-allowed bg-muted/30 text-muted-foreground'
        }`}
      >
        Merge
      </button>
      <button
        type="button"
        onClick={() => onChange('skip')}
        disabled={disabled}
        className={`border-l px-2 py-1 ${value === 'skip' ? 'bg-muted text-foreground' : 'bg-transparent hover:bg-muted'}`}
      >
        Skip
      </button>
    </div>
  );
}

function DoneStage({
  counts,
  onAnother,
}: {
  counts: { created: number; merged: number; skipped: number; batchId: string } | null;
  onAnother: () => void;
}) {
  if (!counts) return null;
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border bg-card p-8 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
        <Check className="size-6" />
      </div>
      <h2 className="text-xl font-semibold">All done.</h2>
      <p className="text-sm text-muted-foreground">
        <span className="font-medium text-foreground">{counts.created}</span>{' '}
        {counts.created === 1 ? 'receipt' : 'receipts'} saved
        {counts.merged > 0 ? (
          <>
            , <span className="font-medium text-foreground">{counts.merged}</span> merged
          </>
        ) : null}
        {counts.skipped > 0 ? (
          <>
            , <span className="font-medium text-foreground">{counts.skipped}</span> skipped
          </>
        ) : null}
        .
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href="/expenses">See your expenses</Link>
        </Button>
        <Button variant="outline" onClick={onAnother}>
          <Upload className="size-3.5" />
          Import more receipts
        </Button>
      </div>
    </div>
  );
}
