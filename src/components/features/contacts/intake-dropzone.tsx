'use client';

/**
 * Intake drop zone. Reusable dashed box that accepts files via drag-and-drop
 * from anywhere (Finder, Mail, Messages, any webpage) or via click-to-pick
 * as a fallback. Mirrors the keyboard / UX contract of photo-upload.tsx so
 * they feel like the same family (see PATTERNS.md §1).
 *
 * Intentionally file-shape-agnostic — the parent decides what to do with the
 * File[] it receives (resize, parse vCards, etc).
 */

import { Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export type IntakeDropzoneProps = {
  /** Files currently staged by the parent. Shown as a file chip list. */
  files: File[];
  /** Called whenever the user drops or picks new files. Parent owns state. */
  onFilesAdded: (files: File[]) => void;
  /** Clear handler for individual chips. Parent removes the file from state. */
  onRemove?: (index: number) => void;
  /** MIME / extension list passed to the native input. */
  accept?: string;
  /** Allow multi-file pick + drop. */
  multiple?: boolean;
  /** Hint shown inside the box on the empty state. */
  hint?: string;
  /** Disable interaction (during a parse round-trip). */
  disabled?: boolean;
  /** Id so a surrounding <label> can wire into the underlying input. */
  inputId?: string;
};

export function IntakeDropzone({
  files,
  onFilesAdded,
  onRemove,
  accept = 'image/*,application/pdf',
  multiple = true,
  hint = 'Drag a file here, or click to choose.',
  disabled = false,
  inputId,
}: IntakeDropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);

  function handleDrop(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setIsDraggingOver(false);
    if (disabled) return;
    const dropped = e.dataTransfer?.files;
    if (dropped && dropped.length > 0) {
      onFilesAdded(Array.from(dropped));
    }
  }

  function handleDragOver(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    if (disabled) return;
    setIsDraggingOver(true);
  }

  function handleDragLeave(e: React.DragEvent<HTMLButtonElement>) {
    e.preventDefault();
    setIsDraggingOver(false);
  }

  function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files && e.target.files.length > 0) {
      onFilesAdded(Array.from(e.target.files));
    }
    // Allow picking the same filename twice.
    e.target.value = '';
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-slot="intake-dropzone"
        data-drag-over={isDraggingOver ? 'true' : undefined}
        aria-label="Drop files or click to choose"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-card px-4 py-6 text-center transition-colors',
          disabled && 'cursor-not-allowed opacity-60',
          isDraggingOver
            ? 'border-primary bg-primary/5'
            : 'border-muted-foreground/25 hover:border-muted-foreground/50',
        )}
      >
        <Upload
          className={cn('size-5', isDraggingOver ? 'text-primary' : 'text-muted-foreground')}
          aria-hidden
        />
        <p className="text-sm font-medium">{isDraggingOver ? 'Drop to add' : 'Drop files here'}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </button>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={handlePick}
      />
      {files.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {files.map((f, i) => {
            // Files have no stable id; name+size+lastModified is our best
            // approximation and usually unique enough in practice.
            const key = `${f.name}-${f.size}-${f.lastModified}`;
            return (
              <li
                key={key}
                className="flex items-center gap-2 rounded-full border bg-muted/50 px-3 py-1 text-xs"
              >
                <span className="max-w-[14rem] truncate" title={f.name}>
                  {f.name}
                </span>
                {onRemove ? (
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => onRemove(i)}
                  >
                    ×
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
