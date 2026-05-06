'use client';

/**
 * Invoice import wizard. Phase C.
 *
 * Same shape as A and B, with the preview table widened to show the
 * frozen money math (subtotal / tax / total) and dual-FK resolution
 * (customer + project) per row. Operator can edit any value inline
 * before commit; if a money field is missing, the row stays in
 * 'create' but the commit action will reject the batch with a
 * specific error pointing at the offending rows.
 */

import { ArrowRight, Check, Loader2, Sparkles, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { IntakeDropzone } from '@/components/features/contacts/intake-dropzone';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  type CommitInvoiceImportRow,
  commitInvoiceImportAction,
  type InvoiceImportProposalRow,
  parseInvoiceImportAction,
} from '@/server/actions/onboarding-import-invoices';

type Stage = 'input' | 'preview' | 'done';

type RowState = InvoiceImportProposalRow & {
  decision: 'create' | 'merge' | 'skip';
};

export function InvoiceImportWizard() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('input');
  const [pending, startTransition] = useTransition();

  const [files, setFiles] = useState<File[]>([]);
  const [pasted, setPasted] = useState('');

  const [rows, setRows] = useState<RowState[]>([]);
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  const [sourceStoragePath, setSourceStoragePath] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const [doneCounts, setDoneCounts] = useState<{
    created: number;
    merged: number;
    skipped: number;
    customersCreated: number;
    projectsCreated: number;
    batchId: string;
  } | null>(null);

  function handleParse() {
    const fd = new FormData();
    if (files[0]) fd.set('file', files[0]);
    else if (pasted.trim()) fd.set('text', pasted);
    else {
      toast.error('Drop a file or paste your invoice list first.');
      return;
    }

    startTransition(async () => {
      const res = await parseInvoiceImportAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.rows.length === 0) {
        toast.error("Henry didn't recognize any invoices in that. Try a different format?");
        return;
      }
      setRows(
        res.rows.map((r) => ({
          ...r,
          decision: r.invoiceMatch.tier ? 'merge' : 'create',
        })),
      );
      setSourceFilename(res.sourceFilename);
      setSourceStoragePath(res.sourceStoragePath);
      setStage('preview');
    });
  }

  function handleCommit() {
    const commitRows: CommitInvoiceImportRow[] = rows.map((r) => ({
      rowKey: r.rowKey,
      decision: r.decision,
      proposed: r.proposed,
      customer: r.customer,
      project: r.project,
    }));
    startTransition(async () => {
      const res = await commitInvoiceImportAction({
        rows: commitRows,
        sourceFilename,
        sourceStoragePath,
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
        customersCreated: res.customersCreated,
        projectsCreated: res.projectsCreated,
        batchId: res.batchId,
      });
      setStage('done');
      router.refresh();
    });
  }

  function handleReset() {
    setStage('input');
    setFiles([]);
    setPasted('');
    setRows([]);
    setSourceFilename(null);
    setSourceStoragePath(null);
    setNote('');
    setDoneCounts(null);
  }

  function updateRow(rowKey: string, updater: (r: RowState) => RowState) {
    setRows((prev) => prev.map((r) => (r.rowKey === rowKey ? updater(r) : r)));
  }

  if (stage === 'input') {
    return (
      <InputStage
        files={files}
        setFiles={setFiles}
        pasted={pasted}
        setPasted={setPasted}
        pending={pending}
        onParse={handleParse}
      />
    );
  }
  if (stage === 'preview') {
    return (
      <PreviewStage
        rows={rows}
        updateRow={updateRow}
        note={note}
        setNote={setNote}
        sourceFilename={sourceFilename}
        pending={pending}
        onCommit={handleCommit}
        onBack={() => setStage('input')}
      />
    );
  }
  return <DoneStage counts={doneCounts} onAnother={handleReset} />;
}

function InputStage({
  files,
  setFiles,
  pasted,
  setPasted,
  pending,
  onParse,
}: {
  files: File[];
  setFiles: (f: File[]) => void;
  pasted: string;
  setPasted: (v: string) => void;
  pending: boolean;
  onParse: () => void;
}) {
  const canParse = !pending && (files.length > 0 || pasted.trim().length > 0);
  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border bg-card p-5">
        <p className="mb-3 text-sm font-medium">Upload a file</p>
        <IntakeDropzone
          files={files}
          onFilesAdded={(f) => setFiles(f.slice(0, 1))}
          onRemove={() => setFiles([])}
          accept=".csv,.tsv,.txt,text/csv,text/plain,text/tab-separated-values"
          multiple={false}
          hint="QuickBooks invoice export, Jobber CSV, Excel-as-CSV, or plain text."
          disabled={pending}
        />
      </div>

      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <div className="rounded-xl border bg-card p-5">
        <Label htmlFor="paste" className="mb-2 block text-sm font-medium">
          Paste a list
        </Label>
        <Textarea
          id="paste"
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          placeholder={
            'Sarah Smith — Smith Bathroom — 2024-11-05 — $5,000 + $250 GST = $5,250 — paid\nThe Hendersons — — 2024-12-12 — $12,000 + $600 = $12,600 — sent'
          }
          rows={6}
          disabled={pending}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Customer, project (if any), date, subtotal, tax, total, status. Henry sorts it out.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <Button onClick={onParse} disabled={!canParse}>
          {pending ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Henry is reading…
            </>
          ) : (
            <>
              <Sparkles className="size-3.5" />
              Read it
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function PreviewStage({
  rows,
  updateRow,
  note,
  setNote,
  sourceFilename,
  pending,
  onCommit,
  onBack,
}: {
  rows: RowState[];
  updateRow: (rowKey: string, updater: (r: RowState) => RowState) => void;
  note: string;
  setNote: (v: string) => void;
  sourceFilename: string | null;
  pending: boolean;
  onCommit: () => void;
  onBack: () => void;
}) {
  const counts = {
    create: rows.filter((r) => r.decision === 'create').length,
    merge: rows.filter((r) => r.decision === 'merge').length,
    skip: rows.filter((r) => r.decision === 'skip').length,
    customersToCreate: rows.filter((r) => r.decision !== 'skip' && r.customer.kind === 'create')
      .length,
    projectsToCreate: rows.filter((r) => r.decision !== 'skip' && r.project.kind === 'create')
      .length,
    moneyMissing: rows.filter(
      (r) =>
        r.decision === 'create' &&
        (r.proposed.subtotalCents === null || r.proposed.taxCents === null),
    ).length,
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            Henry found {rows.length} {rows.length === 1 ? 'invoice' : 'invoices'}
          </span>
          {sourceFilename ? (
            <span className="text-xs text-muted-foreground">in {sourceFilename}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary">{counts.create} new</Badge>
          {counts.merge > 0 ? <Badge variant="secondary">{counts.merge} merged</Badge> : null}
          {counts.skip > 0 ? <Badge variant="outline">{counts.skip} skipped</Badge> : null}
          {counts.customersToCreate > 0 ? (
            <Badge variant="outline" className="border-amber-300 text-amber-900">
              + {counts.customersToCreate} new customer
              {counts.customersToCreate === 1 ? '' : 's'}
            </Badge>
          ) : null}
          {counts.projectsToCreate > 0 ? (
            <Badge variant="outline" className="border-amber-300 text-amber-900">
              + {counts.projectsToCreate} new project
              {counts.projectsToCreate === 1 ? '' : 's'}
            </Badge>
          ) : null}
          {counts.moneyMissing > 0 ? (
            <Badge variant="outline" className="border-red-400 text-red-700">
              {counts.moneyMissing} missing money
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Customer / Project</th>
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-right font-medium">Subtotal</th>
              <th className="px-3 py-2 text-right font-medium">Tax</th>
              <th className="px-3 py-2 text-right font-medium">Total</th>
              <th className="px-3 py-2 text-left font-medium">Status</th>
              <th className="px-3 py-2 text-right font-medium">Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.rowKey}
                className={`border-b last:border-0 ${r.decision === 'skip' ? 'opacity-50' : ''}`}
              >
                <td className="px-3 py-2 align-top">
                  <CustomerProjectCell row={r} />
                  {r.invoiceMatch.tier ? (
                    <p className="mt-0.5 text-xs text-amber-700">
                      Probable duplicate ({r.invoiceMatch.label})
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                  {r.proposed.invoiceDateIso ?? '—'}
                </td>
                <MoneyCell
                  cents={r.proposed.subtotalCents}
                  text={r.proposed.subtotalText}
                  onChange={(c) =>
                    updateRow(r.rowKey, (row) => ({
                      ...row,
                      proposed: { ...row.proposed, subtotalCents: c },
                    }))
                  }
                  disabled={pending}
                />
                <MoneyCell
                  cents={r.proposed.taxCents}
                  text={r.proposed.taxText}
                  onChange={(c) =>
                    updateRow(r.rowKey, (row) => ({
                      ...row,
                      proposed: { ...row.proposed, taxCents: c },
                    }))
                  }
                  disabled={pending}
                />
                <td className="px-3 py-2 align-top text-right text-xs tabular-nums">
                  {r.proposed.totalCents !== null
                    ? formatCents(r.proposed.totalCents)
                    : (r.proposed.totalText ?? '—')}
                </td>
                <td className="px-3 py-2 align-top">
                  <StatusPill status={r.proposed.status} />
                </td>
                <td className="px-3 py-2 align-top text-right">
                  <DecisionToggle
                    value={r.decision}
                    hasMatch={r.invoiceMatch.tier !== null}
                    disabled={pending}
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
            placeholder="e.g. 2024 invoices from QuickBooks"
            disabled={pending}
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={onBack} disabled={pending}>
            Back
          </Button>
          <Button
            onClick={onCommit}
            disabled={pending || counts.create + counts.merge === 0 || counts.moneyMissing > 0}
          >
            {pending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Bringing them in…
              </>
            ) : (
              <>
                Bring them in
                <ArrowRight className="size-3.5" />
              </>
            )}
          </Button>
        </div>
        {counts.moneyMissing > 0 ? (
          <p className="text-xs text-red-700">
            Fix the {counts.moneyMissing} row{counts.moneyMissing === 1 ? '' : 's'} with missing
            subtotal or tax (or set them to skip) before committing.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function CustomerProjectCell({ row }: { row: RowState }) {
  const cust = row.customer;
  const proj = row.project;
  return (
    <div className="flex flex-col gap-0.5 text-sm">
      <span className="font-medium">
        {cust.kind === 'matched' ? cust.existingName : cust.kind === 'create' ? cust.newName : '—'}
      </span>
      <span className="text-xs">
        {proj.kind === 'matched' ? (
          <span className="text-muted-foreground">→ {proj.existingName}</span>
        ) : proj.kind === 'create' ? (
          <span className="text-amber-800">→ {proj.newName} (new)</span>
        ) : (
          <span className="text-muted-foreground">— no project —</span>
        )}
      </span>
      {cust.kind === 'create' ? (
        <span className="text-xs text-amber-800">Will create new customer</span>
      ) : null}
      {row.proposed.customerNote ? (
        <span className="line-clamp-2 text-xs text-muted-foreground">
          {row.proposed.customerNote}
        </span>
      ) : null}
    </div>
  );
}

function MoneyCell({
  cents,
  text,
  onChange,
  disabled,
}: {
  cents: number | null;
  text: string | null | undefined;
  onChange: (c: number | null) => void;
  disabled: boolean;
}) {
  // Operator-editable in dollars. We round-trip through cents for storage.
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
        placeholder={text ?? '—'}
        className="w-20 rounded border-transparent bg-transparent px-1 text-right text-xs tabular-nums hover:border-input focus:border-input"
      />
    </td>
  );
}

function StatusPill({ status }: { status: 'draft' | 'sent' | 'paid' | 'void' }) {
  const tone =
    status === 'paid'
      ? 'bg-emerald-100 text-emerald-900'
      : status === 'sent'
        ? 'bg-blue-100 text-blue-900'
        : status === 'void'
          ? 'bg-muted text-muted-foreground line-through'
          : 'bg-muted text-foreground';
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {status}
    </span>
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
        title={hasMatch ? 'Skip the insert; row already exists.' : 'No probable duplicate found'}
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

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function DoneStage({
  counts,
  onAnother,
}: {
  counts: {
    created: number;
    merged: number;
    skipped: number;
    customersCreated: number;
    projectsCreated: number;
    batchId: string;
  } | null;
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
        {counts.created === 1 ? 'invoice' : 'invoices'}
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
        {counts.customersCreated > 0 || counts.projectsCreated > 0 ? (
          <>
            {' '}
            ·{' '}
            {counts.customersCreated > 0 ? (
              <>
                <span className="font-medium text-foreground">{counts.customersCreated}</span>{' '}
                customer{counts.customersCreated === 1 ? '' : 's'}
              </>
            ) : null}
            {counts.customersCreated > 0 && counts.projectsCreated > 0 ? ' + ' : ''}
            {counts.projectsCreated > 0 ? (
              <>
                <span className="font-medium text-foreground">{counts.projectsCreated}</span>{' '}
                project{counts.projectsCreated === 1 ? '' : 's'}
              </>
            ) : null}{' '}
            created alongside
          </>
        ) : null}
        .
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href="/invoices">See your invoices</Link>
        </Button>
        <Button variant="outline" onClick={onAnother}>
          <Upload className="size-3.5" />
          Import another file
        </Button>
      </div>
    </div>
  );
}
