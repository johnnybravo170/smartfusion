'use client';

/**
 * Project import wizard. Phase B.
 *
 * Same three-stage shape as the customer wizard, with two extra
 * complexities surfaced in the preview:
 *
 *   - **Customer reference column** — each project carries a customer.
 *     The wizard shows whether Henry matched the row to an existing
 *     customer, will create a new one, or left it unattached. The
 *     operator can flip per row.
 *   - **Project-level dedup** — a row can match an existing project
 *     by (customer + name) or by name alone. The decision toggle
 *     respects the match strength.
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
  type CommitProjectImportRow,
  commitProjectImportAction,
  type ProjectImportProposalRow,
  parseProjectImportAction,
} from '@/server/actions/onboarding-import-projects';

type Stage = 'input' | 'preview' | 'done';

type RowState = ProjectImportProposalRow & {
  decision: 'create' | 'merge' | 'skip';
};

export function ProjectImportWizard() {
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
    batchId: string;
  } | null>(null);

  function handleParse() {
    const fd = new FormData();
    if (files[0]) fd.set('file', files[0]);
    else if (pasted.trim()) fd.set('text', pasted);
    else {
      toast.error('Drop a file or paste your project list first.');
      return;
    }

    startTransition(async () => {
      const res = await parseProjectImportAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.rows.length === 0) {
        toast.error("Henry didn't recognize any projects in that. Try a different format?");
        return;
      }
      setRows(
        res.rows.map((r) => ({
          ...r,
          // Default decision: 'merge' on a high-confidence project match
          // (same customer + same name) so re-imports don't duplicate;
          // 'create' otherwise.
          decision: r.projectMatch.tier === 'customer+name' ? 'merge' : 'create',
        })),
      );
      setSourceFilename(res.sourceFilename);
      setSourceStoragePath(res.sourceStoragePath);
      setStage('preview');
    });
  }

  function handleCommit() {
    const commitRows: CommitProjectImportRow[] = rows.map((r) => ({
      rowKey: r.rowKey,
      decision: r.decision,
      existingProjectId: r.projectMatch.existingId,
      proposed: r.proposed,
      customer: r.customer,
    }));
    startTransition(async () => {
      const res = await commitProjectImportAction({
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
          hint="Google Sheets exported as CSV, Excel-as-CSV, or plain text."
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
            'Smith Bathroom — Sarah Smith — Full reno, master suite\nBrandscombe Update — Heather Brandscombe — paint + flooring\n…'
          }
          rows={6}
          disabled={pending}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Project names, customer names, descriptions. Henry sorts it out.
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
    customersMatched: rows.filter((r) => r.decision !== 'skip' && r.customer.kind === 'matched')
      .length,
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            Henry found {rows.length} {rows.length === 1 ? 'project' : 'projects'}
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
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Project</th>
              <th className="px-3 py-2 text-left font-medium">Customer</th>
              <th className="px-3 py-2 text-left font-medium">Match</th>
              <th className="px-3 py-2 text-right font-medium">Decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.rowKey}
                className={`border-b last:border-0 ${r.decision === 'skip' ? 'opacity-50' : ''}`}
              >
                <td className="px-3 py-2">
                  <Input
                    value={r.proposed.name}
                    onChange={(e) =>
                      updateRow(r.rowKey, (row) => ({
                        ...row,
                        proposed: { ...row.proposed, name: e.target.value },
                      }))
                    }
                    className="h-8 border-transparent bg-transparent px-1 hover:border-input focus:border-input"
                    disabled={pending}
                  />
                  {r.proposed.description ? (
                    <p className="mt-0.5 line-clamp-2 px-1 text-xs text-muted-foreground">
                      {r.proposed.description}
                    </p>
                  ) : null}
                  {r.proposed.ballparkAmountText ? (
                    <p className="mt-0.5 px-1 text-xs text-muted-foreground">
                      ~ {r.proposed.ballparkAmountText} ballpark
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2">
                  <CustomerCell row={r} />
                </td>
                <td className="px-3 py-2">
                  {r.projectMatch.tier ? (
                    <div className="flex flex-col gap-0.5 text-xs">
                      <span
                        className={
                          r.projectMatch.tier === 'customer+name'
                            ? 'font-medium text-amber-700'
                            : 'text-muted-foreground'
                        }
                      >
                        {r.projectMatch.label}
                      </span>
                      {r.projectMatch.existingName ? (
                        <span className="text-muted-foreground">
                          → {r.projectMatch.existingName}
                        </span>
                      ) : null}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">New project</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <DecisionToggle
                    value={r.decision}
                    hasMatch={r.projectMatch.tier !== null}
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
            placeholder="e.g. 2025 quotes from Google Sheets"
            disabled={pending}
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={onBack} disabled={pending}>
            Back
          </Button>
          <Button onClick={onCommit} disabled={pending || counts.create + counts.merge === 0}>
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
      </div>
    </div>
  );
}

function CustomerCell({ row }: { row: RowState }) {
  if (row.customer.kind === 'matched') {
    const tone =
      row.customer.tier === 'email' || row.customer.tier === 'phone'
        ? 'text-emerald-700'
        : 'text-foreground';
    return (
      <div className="flex flex-col gap-0.5 text-xs">
        <span className={tone}>{row.customer.existingName}</span>
        <span className="text-muted-foreground">
          Matched ({row.customer.tier === 'name' ? 'name only' : row.customer.tier})
        </span>
      </div>
    );
  }
  if (row.customer.kind === 'create') {
    return (
      <div className="flex flex-col gap-0.5 text-xs">
        <span className="text-amber-800">{row.customer.newName}</span>
        <span className="text-muted-foreground">Will create new customer</span>
      </div>
    );
  }
  return <span className="text-xs text-muted-foreground">— unattached —</span>;
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
          hasMatch
            ? 'Skip the insert; treat as the existing project (Phase C will hang invoices off it).'
            : 'No project match found to merge with'
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
  counts: {
    created: number;
    merged: number;
    skipped: number;
    customersCreated: number;
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
        {counts.created === 1 ? 'project' : 'projects'}
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
        {counts.customersCreated > 0 ? (
          <>
            {' '}
            · <span className="font-medium text-foreground">{counts.customersCreated}</span> new
            customer{counts.customersCreated === 1 ? '' : 's'} created alongside
          </>
        ) : null}
        .
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href="/projects">See your projects</Link>
        </Button>
        <Button variant="outline" onClick={onAnother}>
          <Upload className="size-3.5" />
          Import another file
        </Button>
      </div>
    </div>
  );
}
