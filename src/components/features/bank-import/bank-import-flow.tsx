'use client';

/**
 * Multi-stage bank statement import UI for BR-4.
 *
 * Stages:
 *   1. Upload  — drop / pick a CSV; pick a label + optional preset hint.
 *   2. Preview — shows detected preset / columns / date format with a
 *      confidence badge. User can override any column or jump back to
 *      upload. Sample rows render as a scrollable table.
 *   3. Confirm — submits to the import action, shows insert / skip counts
 *      and links back to /business-health.
 *
 * Mirrors the COA importer's reset / re-upload affordances from
 * coa-mapping-panel.tsx so the two surfaces feel like the same family.
 */

import { Loader2, Pencil, RotateCcw, Upload } from 'lucide-react';
import Link from 'next/link';
import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { IntakeDropzone } from '@/components/features/contacts/intake-dropzone';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { BankPreset, DateFormat, ParsedStatement } from '@/lib/bank-recon';
import { cn } from '@/lib/utils';
import { importBankStatementAction, parseBankStatementAction } from '@/server/actions/bank-import';

const PRESET_OPTIONS: Array<{ value: BankPreset | 'auto'; label: string }> = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'rbc', label: 'RBC' },
  { value: 'td', label: 'TD' },
  { value: 'bmo', label: 'BMO' },
  { value: 'scotia', label: 'Scotiabank' },
  { value: 'cibc', label: 'CIBC' },
  { value: 'amex', label: 'Amex' },
  { value: 'generic', label: 'Generic CSV' },
];

const DATE_FORMAT_OPTIONS: DateFormat[] = [
  'YYYY-MM-DD',
  'YYYY/MM/DD',
  'YYYYMMDD',
  'DD/MM/YYYY',
  'D/M/YYYY',
  'MM/DD/YYYY',
  'M/D/YYYY',
];

type ColumnOverrides = {
  date?: number;
  description?: number;
  amount?: number;
  debit?: number;
  credit?: number;
  date_format?: DateFormat;
};

type Stage =
  | { kind: 'upload' }
  | { kind: 'preview'; file: File; preview: ParsedStatement; overrides: ColumnOverrides }
  | {
      kind: 'done';
      result: {
        total_rows: number;
        inserted: number;
        skipped_duplicates: number;
        warnings: number;
      };
    };

export function BankImportFlow() {
  const [stage, setStage] = useState<Stage>({ kind: 'upload' });

  function reset() {
    setStage({ kind: 'upload' });
  }

  if (stage.kind === 'upload') {
    return (
      <UploadStage
        onParsed={(file, preview) => setStage({ kind: 'preview', file, preview, overrides: {} })}
      />
    );
  }
  if (stage.kind === 'preview') {
    return (
      <PreviewStage
        file={stage.file}
        preview={stage.preview}
        overrides={stage.overrides}
        onOverridesChange={(overrides) => setStage({ ...stage, overrides })}
        onReparse={(newPreview) => setStage({ ...stage, preview: newPreview })}
        onReset={reset}
        onImported={(result) => setStage({ kind: 'done', result })}
      />
    );
  }
  return <DoneStage result={stage.result} onReset={reset} />;
}

// ---------------------------------------------------------------------------
// Stage 1 — upload
// ---------------------------------------------------------------------------

function UploadStage({ onParsed }: { onParsed: (file: File, preview: ParsedStatement) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [sourceLabel, setSourceLabel] = useState('');
  const [presetHint, setPresetHint] = useState<BankPreset | 'auto'>('auto');
  const [pending, startTransition] = useTransition();

  const file = files[0] ?? null;

  function submit() {
    if (!file) {
      toast.error('Pick a CSV first.');
      return;
    }
    if (!sourceLabel.trim()) {
      toast.error('Give the statement a label.');
      return;
    }

    startTransition(async () => {
      const fd = new FormData();
      fd.set('file', file);
      if (presetHint !== 'auto') fd.set('preset_hint', presetHint);
      const res = await parseBankStatementAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Hand the file off to preview unchanged so confirm can re-submit it.
      onParsed(file, res.data);
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Upload bank statement</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="source_label" className="text-sm font-medium">
            Statement label
          </label>
          <Input
            id="source_label"
            value={sourceLabel}
            onChange={(e) => setSourceLabel(e.target.value)}
            placeholder="e.g. RBC Chequing — March 2026"
            disabled={pending}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="preset_hint" className="text-sm font-medium">
            Bank
          </label>
          <Select
            value={presetHint}
            onValueChange={(v) => setPresetHint(v as BankPreset | 'auto')}
            disabled={pending}
          >
            <SelectTrigger id="preset_hint">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESET_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Auto-detect handles every Canadian big bank. Override only if detection fails.
          </p>
        </div>

        <IntakeDropzone
          files={files}
          onFilesAdded={(fs) => setFiles(fs.slice(0, 1))}
          onRemove={() => setFiles([])}
          accept=".csv,text/csv,text/plain"
          multiple={false}
          hint="CSV only · max 5MB"
          disabled={pending}
        />

        <div className="flex justify-end">
          <Button onClick={submit} disabled={pending || !file || !sourceLabel.trim()}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
            <span className="ml-1">Parse statement</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Stage 2 — preview + manual override + confirm
// ---------------------------------------------------------------------------

function PreviewStage({
  file,
  preview,
  overrides,
  onOverridesChange,
  onReparse,
  onReset,
  onImported,
}: {
  file: File;
  preview: ParsedStatement;
  overrides: ColumnOverrides;
  onOverridesChange: (next: ColumnOverrides) => void;
  onReparse: (next: ParsedStatement) => void;
  onReset: () => void;
  onImported: (result: {
    total_rows: number;
    inserted: number;
    skipped_duplicates: number;
    warnings: number;
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [reparsing, startReparse] = useTransition();
  const [importing, startImport] = useTransition();
  const [sourceLabel, setSourceLabel] = useState(file.name.replace(/\.[^.]+$/, ''));

  function applyOverrides() {
    startReparse(async () => {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('manual_overrides', JSON.stringify(overrides));
      const res = await parseBankStatementAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onReparse(res.data);
      setEditing(false);
    });
  }

  function confirmImport() {
    if (!sourceLabel.trim()) {
      toast.error('Give the statement a label.');
      return;
    }
    startImport(async () => {
      const fd = new FormData();
      fd.set('file', file);
      fd.set('source_label', sourceLabel.trim());
      if (preview.detected_preset) fd.set('preset_hint', preview.detected_preset);
      if (Object.keys(overrides).length > 0) {
        fd.set('manual_overrides', JSON.stringify(overrides));
      }
      const res = await importBankStatementAction(fd);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      onImported({
        total_rows: res.total_rows,
        inserted: res.inserted,
        skipped_duplicates: res.skipped_duplicates,
        warnings: res.warnings,
      });
    });
  }

  const confidenceTone =
    preview.confidence === 'high'
      ? 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
      : preview.confidence === 'medium'
        ? 'bg-amber-100 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200'
        : 'bg-rose-100 text-rose-900 dark:bg-rose-950/40 dark:text-rose-200';

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Preview</CardTitle>
        <Button size="sm" variant="ghost" onClick={onReset} disabled={importing}>
          <RotateCcw className="size-3.5" />
          <span className="ml-1">Use a different file</span>
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {/* Detection summary */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium', confidenceTone)}>
            {preview.confidence} confidence
          </span>
          <span className="text-muted-foreground">·</span>
          <span>
            {preview.detected_preset ? (
              <>
                Detected <strong>{preview.detected_preset.toUpperCase()}</strong>
              </>
            ) : (
              <>Generic CSV ({preview.detection_source})</>
            )}
          </span>
          <span className="text-muted-foreground">·</span>
          <span>Date format: {preview.detected_date_format}</span>
          <span className="text-muted-foreground">·</span>
          <span>{preview.rows.length} transactions</span>
          {preview.encoding_fallback_used ? (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-amber-700 dark:text-amber-400">
                Recovered from non-UTF-8 encoding
              </span>
            </>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing((v) => !v)}
            disabled={reparsing || importing}
          >
            <Pencil className="size-3.5" />
            <span className="ml-1">{editing ? 'Hide overrides' : 'Override columns'}</span>
          </Button>
        </div>

        {preview.warnings.length > 0 ? (
          <details className="rounded-md border bg-muted/50 px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium">
              {preview.warnings.length} warning
              {preview.warnings.length === 1 ? '' : 's'}
            </summary>
            <ul className="mt-2 flex flex-col gap-1 text-muted-foreground">
              {preview.warnings.slice(0, 8).map((w, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: warnings are display-only and order-stable within a render
                <li key={i}>{w.message}</li>
              ))}
              {preview.warnings.length > 8 ? (
                <li>…and {preview.warnings.length - 8} more</li>
              ) : null}
            </ul>
          </details>
        ) : null}

        {editing ? (
          <ColumnOverrideForm
            headers={preview.preview.headers}
            overrides={overrides}
            onChange={onOverridesChange}
            onApply={applyOverrides}
            applying={reparsing}
          />
        ) : null}

        {/* Sample table */}
        <div className="overflow-x-auto rounded-md border">
          <table className="min-w-full text-xs">
            <thead className="bg-muted/50 text-left">
              <tr>
                {preview.preview.headers.map((h, i) => (
                  <th
                    // biome-ignore lint/suspicious/noArrayIndexKey: column position IS the identity here
                    key={`hdr-${i}`}
                    className={cn(
                      'whitespace-nowrap px-2 py-1.5 font-medium',
                      i === preview.column_map.date && 'bg-emerald-100 dark:bg-emerald-950/30',
                      i === preview.column_map.description && 'bg-blue-100 dark:bg-blue-950/30',
                      i === preview.column_map.amount && 'bg-amber-100 dark:bg-amber-950/30',
                    )}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.preview.sample.map((row, ri) => (
                <tr
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview rows are static positional samples
                  key={`row-${ri}`}
                  className="border-t"
                >
                  {row.map((cell, ci) => (
                    <td
                      // biome-ignore lint/suspicious/noArrayIndexKey: cell column maps 1:1 to header position
                      key={`cell-${ri}-${ci}`}
                      className={cn(
                        'whitespace-nowrap px-2 py-1.5 tabular-nums',
                        ci === preview.column_map.date && 'bg-emerald-50 dark:bg-emerald-950/10',
                        ci === preview.column_map.description && 'bg-blue-50 dark:bg-blue-950/10',
                        ci === preview.column_map.amount && 'bg-amber-50 dark:bg-amber-950/10',
                      )}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Confirm */}
        <div className="flex flex-col gap-2 border-t pt-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex flex-1 flex-col gap-1">
            <label htmlFor="confirm_label" className="text-xs font-medium text-muted-foreground">
              Save as
            </label>
            <Input
              id="confirm_label"
              value={sourceLabel}
              onChange={(e) => setSourceLabel(e.target.value)}
              disabled={importing}
              className="max-w-md"
            />
          </div>
          <Button
            onClick={confirmImport}
            disabled={importing || reparsing || preview.rows.length === 0}
          >
            {importing ? <Loader2 className="size-4 animate-spin" /> : null}
            <span className={importing ? 'ml-1' : ''}>
              Import {preview.rows.length} transactions
            </span>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ColumnOverrideForm({
  headers,
  overrides,
  onChange,
  onApply,
  applying,
}: {
  headers: string[];
  overrides: ColumnOverrides;
  onChange: (next: ColumnOverrides) => void;
  onApply: () => void;
  applying: boolean;
}) {
  function pick(key: keyof ColumnOverrides) {
    return (v: string) => {
      const numeric = key !== 'date_format';
      onChange({
        ...overrides,
        [key]: numeric ? (v === '' ? undefined : Number(v)) : (v as DateFormat),
      });
    };
  }

  return (
    <div className="grid grid-cols-1 gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-3">
      <ColumnPicker
        label="Date column"
        headers={headers}
        value={overrides.date}
        onChange={pick('date')}
      />
      <ColumnPicker
        label="Description column"
        headers={headers}
        value={overrides.description}
        onChange={pick('description')}
      />
      <ColumnPicker
        label="Amount column (signed)"
        headers={headers}
        value={overrides.amount}
        onChange={pick('amount')}
      />
      <ColumnPicker
        label="Debit column"
        headers={headers}
        value={overrides.debit}
        onChange={pick('debit')}
      />
      <ColumnPicker
        label="Credit column"
        headers={headers}
        value={overrides.credit}
        onChange={pick('credit')}
      />
      <DateFormatPicker value={overrides.date_format} onChange={(v) => pick('date_format')(v)} />

      <div className="sm:col-span-3 flex justify-end">
        <Button size="sm" onClick={onApply} disabled={applying}>
          {applying ? <Loader2 className="size-4 animate-spin" /> : null}
          <span className={applying ? 'ml-1' : ''}>Re-parse with overrides</span>
        </Button>
      </div>
    </div>
  );
}

function ColumnPicker({
  label,
  headers,
  value,
  onChange,
}: {
  label: string;
  headers: string[];
  value: number | undefined;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select value={value !== undefined ? String(value) : ''} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Auto-detected" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="-1">— None / Unused —</SelectItem>
          {headers.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: column position IS the value, by design
            <SelectItem key={i} value={String(i)}>
              {i}: {h || `col_${i}`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function DateFormatPicker({
  value,
  onChange,
}: {
  value: DateFormat | undefined;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        Date format
      </label>
      <Select value={value ?? ''} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Auto-detected" />
        </SelectTrigger>
        <SelectContent>
          {DATE_FORMAT_OPTIONS.map((f) => (
            <SelectItem key={f} value={f}>
              {f}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stage 3 — done
// ---------------------------------------------------------------------------

function DoneStage({
  result,
  onReset,
}: {
  result: { total_rows: number; inserted: number; skipped_duplicates: number; warnings: number };
  onReset: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Statement imported</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            <strong className="tabular-nums">{result.inserted}</strong> new transaction
            {result.inserted === 1 ? '' : 's'} added
          </li>
          {result.skipped_duplicates > 0 ? (
            <li className="text-muted-foreground">
              {result.skipped_duplicates} already imported (skipped)
            </li>
          ) : null}
          {result.warnings > 0 ? (
            <li className="text-muted-foreground">{result.warnings} row warnings</li>
          ) : null}
        </ul>
        <p className="text-xs text-muted-foreground">
          Auto-matching against unpaid invoices and expenses lands in BR-5; for now your
          transactions are saved and queued for review.
        </p>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/business-health">Back to Business Health</Link>
          </Button>
          <Button variant="ghost" onClick={onReset}>
            Import another statement
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
