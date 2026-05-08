'use client';

/**
 * Time-entry import wizard. Phase F (last).
 *
 * Same three-stage shape as A/B/C. Two domain-specific quirks vs the
 * earlier text wizards:
 *   - Worker resolution is read-only (can't auto-create auth users).
 *     Unmatched rows fall back to the importing user; operator can flip
 *     per row to an existing tenant member or skip.
 *   - Hours are decimal numbers; the model normalizes "8h" / "8:00" /
 *     "0.5 day" upstream, but the wizard exposes a numeric input for
 *     manual overrides on rows the model couldn't parse.
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
  type CommitTimeEntryRow,
  commitTimeEntryImportAction,
  parseTimeEntryImportAction,
  type TimeEntryProposalRow,
} from '@/server/actions/onboarding-import-time-entries';

type Stage = 'input' | 'preview' | 'done';

type RowState = TimeEntryProposalRow & {
  /** Resolved at preview-time. Defaults to matched.userId, or
   *  fallback_to_importer's importer userId, or empty for unmatched
   *  rows (operator must pick before commit). */
  selectedUserId: string;
  selectedProjectId: string | null;
  decision: 'create' | 'skip';
  /** When true the operator manually changed the worker pick — the UI
   *  shows a small pill so the override is visible. */
  workerOverridden: boolean;
};

type MemberOption = { userId: string; label: string };

const SKIP_USER_SENTINEL = '';

export function TimeEntryImportWizard() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('input');
  const [pending, startTransition] = useTransition();

  const [files, setFiles] = useState<File[]>([]);
  const [pasted, setPasted] = useState('');

  const [rows, setRows] = useState<RowState[]>([]);
  const [members, setMembers] = useState<MemberOption[]>([]);
  const [importerUserId, setImporterUserId] = useState<string>('');
  const [sourceFilename, setSourceFilename] = useState<string | null>(null);
  const [sourceStoragePath, setSourceStoragePath] = useState<string | null>(null);
  const [note, setNote] = useState('');

  const [doneCounts, setDoneCounts] = useState<{
    created: number;
    skipped: number;
    batchId: string;
  } | null>(null);

  function handleParse() {
    const fd = new FormData();
    if (files[0]) fd.set('file', files[0]);
    else if (pasted.trim()) fd.set('text', pasted);
    else {
      toast.error('Drop a file or paste your time entries first.');
      return;
    }

    startTransition(async () => {
      const res = await parseTimeEntryImportAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      if (res.rows.length === 0) {
        toast.error("Henry didn't recognize any time entries. Try a different format?");
        return;
      }
      setMembers(res.members);
      // The importer's userId is whichever member-option matches the
      // 'fallback_to_importer' rows; we capture it for the picker
      // default. If nothing falls back (no missing names), pick any
      // first member as the picker default.
      const importerFallback = res.rows.find((r) => r.worker.kind === 'fallback_to_importer')
        ?.worker.kind;
      const importerLabel =
        res.rows.find((r) => r.worker.kind === 'fallback_to_importer')?.worker.kind ===
        'fallback_to_importer'
          ? (
              res.rows.find((r) => r.worker.kind === 'fallback_to_importer')?.worker as {
                importerLabel: string;
              }
            ).importerLabel
          : null;
      const importerMember = importerLabel
        ? res.members.find((m) => m.label === importerLabel)
        : null;
      const importer = importerMember?.userId ?? res.members[0]?.userId ?? '';
      setImporterUserId(importer);
      // void the unused capture (helper for future refactors)
      void importerFallback;

      setRows(
        res.rows.map((r) => {
          const initialUserId =
            r.worker.kind === 'matched'
              ? r.worker.userId
              : r.worker.kind === 'fallback_to_importer'
                ? importer
                : SKIP_USER_SENTINEL;
          return {
            ...r,
            selectedUserId: initialUserId,
            selectedProjectId: r.project.kind === 'matched' ? r.project.existingId : null,
            decision: initialUserId ? 'create' : 'skip',
            workerOverridden: false,
          };
        }),
      );
      setSourceFilename(res.sourceFilename);
      setSourceStoragePath(res.sourceStoragePath);
      setStage('preview');
    });
  }

  function handleCommit() {
    const commitRows: CommitTimeEntryRow[] = rows
      .filter((r) => r.decision === 'create' && r.selectedUserId)
      .map((r) => ({
        rowKey: r.rowKey,
        decision: r.decision,
        userId: r.selectedUserId,
        proposed: r.proposed,
        projectId: r.selectedProjectId,
      }));
    startTransition(async () => {
      const res = await commitTimeEntryImportAction({
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
    setPasted('');
    setRows([]);
    setMembers([]);
    setImporterUserId('');
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
        members={members}
        importerUserId={importerUserId}
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
          hint="Payroll CSV, time-tracking export, Google Sheets, plain text."
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
            'Sam Patel — Smith Bathroom — 2025-04-12 — 8h\nMe — Brandscombe Update — 2025-04-13 — 4.5 — paint touchups\n…'
          }
          rows={6}
          disabled={pending}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          Worker, project, date, hours, optional notes — Henry sorts it out.
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
  members,
  importerUserId,
  updateRow,
  note,
  setNote,
  sourceFilename,
  pending,
  onCommit,
  onBack,
}: {
  rows: RowState[];
  members: MemberOption[];
  importerUserId: string;
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
    skip: rows.filter((r) => r.decision === 'skip').length,
    unmatched: rows.filter((r) => r.worker.kind === 'unmatched' && !r.workerOverridden).length,
    missingHours: rows.filter(
      (r) => r.decision === 'create' && (r.proposed.hours === null || r.proposed.hours <= 0),
    ).length,
  };
  const totalHours = rows
    .filter((r) => r.decision === 'create')
    .reduce((s, r) => s + (r.proposed.hours ?? 0), 0);
  void importerUserId;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            Henry found {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
          </span>
          {sourceFilename ? (
            <span className="text-xs text-muted-foreground">in {sourceFilename}</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary">{counts.create} new</Badge>
          {counts.skip > 0 ? <Badge variant="outline">{counts.skip} skipped</Badge> : null}
          <Badge variant="outline">{totalHours.toFixed(2)} hrs total</Badge>
          {counts.unmatched > 0 ? (
            <Badge variant="outline" className="border-amber-300 text-amber-900">
              {counts.unmatched} unmatched worker
              {counts.unmatched === 1 ? '' : 's'}
            </Badge>
          ) : null}
          {counts.missingHours > 0 ? (
            <Badge variant="outline" className="border-red-400 text-red-700">
              {counts.missingHours} missing hours
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Worker</th>
              <th className="px-3 py-2 text-left font-medium">Project</th>
              <th className="px-3 py-2 text-left font-medium">Date</th>
              <th className="px-3 py-2 text-right font-medium">Hours</th>
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
                  <select
                    value={r.selectedUserId}
                    onChange={(e) =>
                      updateRow(r.rowKey, (row) => ({
                        ...row,
                        selectedUserId: e.target.value,
                        workerOverridden: true,
                        decision: e.target.value ? row.decision : 'skip',
                      }))
                    }
                    disabled={pending}
                    className="h-7 rounded border bg-background px-1 text-xs"
                  >
                    <option value="">— skip —</option>
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">
                    From source: {r.proposed.workerName ?? '—'}
                    {r.worker.kind === 'unmatched' && !r.workerOverridden ? (
                      <span className="ml-1 text-amber-700">(no match)</span>
                    ) : r.worker.kind === 'fallback_to_importer' && !r.workerOverridden ? (
                      <span className="ml-1 text-muted-foreground">→ defaulted to you</span>
                    ) : null}
                  </p>
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {r.project.kind === 'matched' ? (
                    <span>{r.project.existingName}</span>
                  ) : (
                    <span className="text-muted-foreground">— unattached —</span>
                  )}
                  {r.proposed.notes ? (
                    <p className="mt-0.5 line-clamp-2 text-[10px] text-muted-foreground">
                      {r.proposed.notes}
                    </p>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top text-xs">{r.proposed.entryDateIso ?? '—'}</td>
                <td className="px-3 py-2 align-top text-right">
                  <input
                    type="number"
                    step="0.25"
                    min="0"
                    value={r.proposed.hours ?? ''}
                    onChange={(e) => {
                      const v = e.target.value.trim();
                      const n = v ? Number(v) : null;
                      updateRow(r.rowKey, (row) => ({
                        ...row,
                        proposed: {
                          ...row.proposed,
                          hours: n !== null && Number.isFinite(n) && n >= 0 ? n : null,
                        },
                      }));
                    }}
                    disabled={pending}
                    placeholder="—"
                    className="w-16 rounded border-transparent bg-transparent px-1 text-right text-xs tabular-nums hover:border-input focus:border-input"
                  />
                </td>
                <td className="px-3 py-2 align-top text-right">
                  <button
                    type="button"
                    className={`text-xs ${r.decision === 'skip' ? 'text-muted-foreground' : 'text-foreground'} hover:underline`}
                    onClick={() =>
                      updateRow(r.rowKey, (row) => ({
                        ...row,
                        decision: row.decision === 'skip' ? 'create' : 'skip',
                      }))
                    }
                    disabled={pending}
                  >
                    {r.decision === 'skip' ? 'Bring back' : 'Skip'}
                  </button>
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
            placeholder="e.g. 2024 historical hours from payroll spreadsheet"
            disabled={pending}
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={onBack} disabled={pending}>
            Back
          </Button>
          <Button
            onClick={onCommit}
            disabled={pending || counts.create === 0 || counts.missingHours > 0}
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
        {counts.missingHours > 0 ? (
          <p className="text-xs text-red-700">
            Fix the {counts.missingHours} row{counts.missingHours === 1 ? '' : 's'} with missing or
            zero hours (or skip them) before committing.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function DoneStage({
  counts,
  onAnother,
}: {
  counts: { created: number; skipped: number; batchId: string } | null;
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
        {counts.created === 1 ? 'entry' : 'entries'}
        {counts.skipped > 0 ? (
          <>
            , <span className="font-medium text-foreground">{counts.skipped}</span> skipped
          </>
        ) : null}
        .
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href="/import">Back to import</Link>
        </Button>
        <Button variant="outline" onClick={onAnother}>
          <Upload className="size-3.5" />
          Another batch
        </Button>
      </div>
    </div>
  );
}
