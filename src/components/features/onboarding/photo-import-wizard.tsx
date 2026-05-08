'use client';

/**
 * Photo import wizard. Phase E.
 *
 * Three stages, like the other phases, but lighter inside:
 *   1. Pick a project (combobox, server-rendered list).
 *   2. Drop files. Each one uploads via parsePhotoForImportAction with
 *      a per-file progress chip.
 *   3. Review thumbnails — operator can add captions, change tags, or
 *      deselect any unwanted photos before commit.
 *
 * No LLM call in this phase. The existing `ai-worker` cron picks up
 * imported photos with NULL ai_tag and tags them in the background, so
 * the bulk attach is fast and the tagging happens for free.
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
import {
  type CommitPhotoImportRow,
  commitPhotoImportAction,
  type ProposedPhoto,
  parsePhotoForImportAction,
} from '@/server/actions/onboarding-import-photos';

type Stage = 'pick' | 'drop' | 'processing' | 'preview' | 'done';

const PHOTO_TAGS: ProposedPhoto['tag'][] = [
  'before',
  'after',
  'progress',
  'damage',
  'materials',
  'equipment',
  'serial',
  'concern',
  'other',
];

type RowState = ProposedPhoto & {
  rowKey: string;
  decision: 'create' | 'skip';
  parseError?: string;
};

type ProjectOption = { id: string; name: string; customerName: string | null };

export function PhotoImportWizard({ projects }: { projects: ProjectOption[] }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('pick');
  const [pending, startTransition] = useTransition();

  const [projectId, setProjectId] = useState<string>('');
  const [files, setFiles] = useState<File[]>([]);
  const [rows, setRows] = useState<RowState[]>([]);
  const [progress, setProgress] = useState({ done: 0, total: 0, errors: 0 });
  const [note, setNote] = useState('');

  const [doneCounts, setDoneCounts] = useState<{
    created: number;
    skipped: number;
    batchId: string;
  } | null>(null);

  const selectedProject = projects.find((p) => p.id === projectId) ?? null;

  async function handleParse() {
    if (!projectId) {
      toast.error('Pick a project first.');
      return;
    }
    if (files.length === 0) {
      toast.error('Drop some photos first.');
      return;
    }
    setStage('processing');
    setRows([]);
    setProgress({ done: 0, total: files.length, errors: 0 });

    let errors = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fd = new FormData();
      fd.set('file', file);
      fd.set('projectId', projectId);
      const res = await parsePhotoForImportAction(fd);
      if (res.ok) {
        const row: RowState = {
          ...res.proposed,
          rowKey: `p${i}`,
          decision: 'create',
        };
        setRows((prev) => [...prev, row]);
      } else {
        errors += 1;
        setRows((prev) => [
          ...prev,
          {
            rowKey: `p${i}`,
            filename: file.name,
            storagePath: '',
            mime: file.type,
            bytes: file.size,
            caption: null,
            tag: 'progress',
            decision: 'skip',
            parseError: res.error,
          },
        ]);
      }
      setProgress({ done: i + 1, total: files.length, errors });
    }
    setStage('preview');
  }

  function handleCommit() {
    const commitRows: CommitPhotoImportRow[] = rows
      .filter((r) => !r.parseError)
      .map((r) => ({
        storagePath: r.storagePath,
        mime: r.mime,
        bytes: r.bytes,
        caption: r.caption,
        tag: r.tag,
        decision: r.decision,
      }));
    startTransition(async () => {
      const res = await commitPhotoImportAction({
        projectId,
        rows: commitRows,
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
    setStage('pick');
    setProjectId('');
    setFiles([]);
    setRows([]);
    setProgress({ done: 0, total: 0, errors: 0 });
    setNote('');
    setDoneCounts(null);
  }

  function updateRow(rowKey: string, updater: (r: RowState) => RowState) {
    setRows((prev) => prev.map((r) => (r.rowKey === rowKey ? updater(r) : r)));
  }

  if (stage === 'pick') {
    return (
      <PickProjectStage
        projects={projects}
        projectId={projectId}
        setProjectId={setProjectId}
        onContinue={() => setStage('drop')}
      />
    );
  }
  if (stage === 'drop') {
    return (
      <DropStage
        selectedProject={selectedProject}
        files={files}
        setFiles={setFiles}
        pending={pending}
        onParse={handleParse}
        onBack={() => setStage('pick')}
      />
    );
  }
  if (stage === 'processing') {
    return <ProcessingStage progress={progress} rows={rows} />;
  }
  if (stage === 'preview') {
    return (
      <PreviewStage
        rows={rows}
        updateRow={updateRow}
        progress={progress}
        selectedProject={selectedProject}
        note={note}
        setNote={setNote}
        pending={pending}
        onCommit={handleCommit}
        onBack={handleReset}
      />
    );
  }
  return <DoneStage counts={doneCounts} onAnother={handleReset} />;
}

function PickProjectStage({
  projects,
  projectId,
  setProjectId,
  onContinue,
}: {
  projects: ProjectOption[];
  projectId: string;
  setProjectId: (v: string) => void;
  onContinue: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border bg-card p-5">
        <Label htmlFor="project" className="mb-2 block text-sm font-medium">
          Which project are these photos for?
        </Label>
        <select
          id="project"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="h-9 w-full rounded-md border bg-background px-2 text-sm"
        >
          <option value="">— pick a project —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.customerName ? ` · ${p.customerName}` : ''}
            </option>
          ))}
        </select>
        {projects.length === 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            You don&rsquo;t have any projects yet.{' '}
            <Link href="/projects/import" className="underline">
              Import projects first
            </Link>
            , or create one manually.
          </p>
        ) : null}
      </div>
      <div className="flex justify-end">
        <Button onClick={onContinue} disabled={!projectId}>
          Continue
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function DropStage({
  selectedProject,
  files,
  setFiles,
  pending,
  onParse,
  onBack,
}: {
  selectedProject: ProjectOption | null;
  files: File[];
  setFiles: (f: File[]) => void;
  pending: boolean;
  onParse: () => void;
  onBack: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground">
        Attaching to <span className="font-medium text-foreground">{selectedProject?.name}</span>
        {selectedProject?.customerName ? <> · {selectedProject.customerName}</> : null}
      </div>
      <div className="rounded-xl border bg-card p-5">
        <p className="mb-3 text-sm font-medium">Drop the photos</p>
        <IntakeDropzone
          files={files}
          onFilesAdded={(f) => setFiles([...files, ...f])}
          onRemove={(i) => setFiles(files.filter((_, idx) => idx !== i))}
          accept="image/*"
          multiple
          hint="JPEG, PNG, HEIC, WebP. Drop as many as you like — they upload one at a time."
          disabled={pending}
        />
      </div>
      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onParse} disabled={files.length === 0}>
          <Sparkles className="size-3.5" />
          Upload {files.length} photo{files.length === 1 ? '' : 's'}
        </Button>
      </div>
    </div>
  );
}

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
      <div className="rounded-xl border bg-card p-6 text-center">
        <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">
          Uploading {progress.done} of {progress.total}…
        </p>
        {progress.errors > 0 ? (
          <p className="mt-1 text-xs text-amber-700">
            {progress.errors} couldn&rsquo;t be read — they&rsquo;ll be flagged in the next step.
          </p>
        ) : null}
        <div
          role="progressbar"
          aria-label={`${pct}% complete`}
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mx-auto mt-4 h-2 w-full max-w-md overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
      </div>
      {rows.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Latest:{' '}
          <span className="font-medium text-foreground">{rows[rows.length - 1].filename}</span>
        </p>
      ) : null}
    </div>
  );
}

function PreviewStage({
  rows,
  updateRow,
  progress,
  selectedProject,
  note,
  setNote,
  pending,
  onCommit,
  onBack,
}: {
  rows: RowState[];
  updateRow: (rowKey: string, updater: (r: RowState) => RowState) => void;
  progress: { done: number; total: number; errors: number };
  selectedProject: ProjectOption | null;
  note: string;
  setNote: (v: string) => void;
  pending: boolean;
  onCommit: () => void;
  onBack: () => void;
}) {
  const counts = {
    create: rows.filter((r) => r.decision === 'create' && !r.parseError).length,
    skip: rows.filter((r) => r.decision === 'skip' || r.parseError).length,
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">
            {progress.total} photo{progress.total === 1 ? '' : 's'} →{' '}
            {selectedProject?.name ?? 'project'}
          </span>
          {progress.errors > 0 ? (
            <span className="text-xs text-amber-700">{progress.errors} couldn&rsquo;t read</span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="secondary">{counts.create} attaching</Badge>
          {counts.skip > 0 ? <Badge variant="outline">{counts.skip} skipped</Badge> : null}
        </div>
      </div>

      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {rows.map((r) => (
          <li
            key={r.rowKey}
            className={`flex flex-col gap-2 rounded-xl border bg-card p-3 ${
              r.decision === 'skip' ? 'opacity-60' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{r.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {r.parseError ? (
                    <span className="text-red-700">{r.parseError}</span>
                  ) : (
                    <>
                      {Math.round(r.bytes / 1024)} KB · {r.mime}
                    </>
                  )}
                </p>
              </div>
              {!r.parseError ? (
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
              ) : null}
            </div>
            {!r.parseError ? (
              <>
                <Input
                  value={r.caption ?? ''}
                  onChange={(e) =>
                    updateRow(r.rowKey, (row) => ({
                      ...row,
                      caption: e.target.value || null,
                    }))
                  }
                  placeholder="Caption (optional)"
                  className="h-7 text-xs"
                  disabled={pending || r.decision === 'skip'}
                />
                <select
                  value={r.tag}
                  onChange={(e) =>
                    updateRow(r.rowKey, (row) => ({
                      ...row,
                      tag: e.target.value as ProposedPhoto['tag'],
                    }))
                  }
                  className="h-7 rounded border bg-background px-1 text-xs"
                  disabled={pending || r.decision === 'skip'}
                >
                  {PHOTO_TAGS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </>
            ) : null}
          </li>
        ))}
      </ul>

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
            placeholder="e.g. 2024 progress shots"
            disabled={pending}
          />
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" onClick={onBack} disabled={pending}>
            Start over
          </Button>
          <Button onClick={onCommit} disabled={pending || counts.create === 0}>
            {pending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Attaching…
              </>
            ) : (
              <>
                Attach {counts.create} photo{counts.create === 1 ? '' : 's'}
                <ArrowRight className="size-3.5" />
              </>
            )}
          </Button>
        </div>
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
        {counts.created === 1 ? 'photo' : 'photos'} attached
        {counts.skipped > 0 ? (
          <>
            , <span className="font-medium text-foreground">{counts.skipped}</span> skipped
          </>
        ) : null}
        . Henry will tag them in the background — you don&rsquo;t have to wait.
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
