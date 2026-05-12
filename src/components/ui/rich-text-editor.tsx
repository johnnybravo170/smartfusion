'use client';

/**
 * Markdown editor: textarea + toolbar.
 *
 * Deliberately NOT a WYSIWYG. Operators see raw markdown (`**bold**`, `- item`),
 * the toolbar inserts the syntax at the cursor, and they're free to type the
 * symbols directly. This is the GitHub-style "edit box" pattern — predictable,
 * easy to migrate to/from any other tool, and ~zero JS overhead beyond a
 * textarea.
 *
 * Pairs with `<RichTextDisplay markdown={...} />` for read-side rendering.
 *
 * Supported toolbar buttons: bold, italic, h3, bulleted list, numbered list.
 * Add more sparingly — the value of a small surface is predictability.
 */

import { Bold, Heading, Italic, List, ListOrdered } from 'lucide-react';
import { useRef } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

type Props = {
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  className?: string;
  /** Optional label rendered above the toolbar. */
  label?: string;
  /** Optional id passed through to the textarea (for label binding). */
  id?: string;
};

type Action =
  | { kind: 'wrap'; prefix: string; suffix: string; placeholder: string }
  | { kind: 'linePrefix'; prefix: string; placeholder: string };

function applyAction(
  textarea: HTMLTextAreaElement,
  current: string,
  action: Action,
): { next: string; selectionStart: number; selectionEnd: number } {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const selected = current.slice(start, end);

  if (action.kind === 'wrap') {
    const inner = selected.length > 0 ? selected : action.placeholder;
    const insert = `${action.prefix}${inner}${action.suffix}`;
    const next = `${current.slice(0, start)}${insert}${current.slice(end)}`;
    const cursor = start + action.prefix.length;
    return {
      next,
      selectionStart: cursor,
      selectionEnd: cursor + inner.length,
    };
  }

  // linePrefix: insert at the start of each selected line (or the current line if no selection)
  const before = current.slice(0, start);
  const lineStart = before.lastIndexOf('\n') + 1;
  const after = current.slice(end);
  const nextNewline = after.indexOf('\n');
  const lineEnd = nextNewline === -1 ? current.length : end + nextNewline;
  const block = current.slice(lineStart, lineEnd);
  const lines = block === '' ? [action.placeholder] : block.split('\n');
  const prefixed = lines.map((line, i) => {
    if (action.prefix === '1. ') return `${i + 1}. ${line}`;
    return `${action.prefix}${line}`;
  });
  const insert = prefixed.join('\n');
  const next = `${current.slice(0, lineStart)}${insert}${current.slice(lineEnd)}`;
  return {
    next,
    selectionStart: lineStart,
    selectionEnd: lineStart + insert.length,
  };
}

export function RichTextEditor({
  value,
  onChange,
  onBlur,
  placeholder,
  rows = 4,
  disabled,
  className,
  label,
  id,
}: Props) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  function run(action: Action) {
    const el = ref.current;
    if (!el) return;
    const result = applyAction(el, value, action);
    onChange(result.next);
    // Restore selection after React re-renders.
    requestAnimationFrame(() => {
      if (!ref.current) return;
      ref.current.focus();
      ref.current.setSelectionRange(result.selectionStart, result.selectionEnd);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!(e.metaKey || e.ctrlKey)) return;
    if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      run({ kind: 'wrap', prefix: '**', suffix: '**', placeholder: 'bold' });
    } else if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      run({ kind: 'wrap', prefix: '*', suffix: '*', placeholder: 'italic' });
    }
  }

  const buttons: Array<{
    icon: typeof Bold;
    label: string;
    action: Action;
    shortcut?: string;
  }> = [
    {
      icon: Bold,
      label: 'Bold',
      shortcut: 'Ctrl+B',
      action: { kind: 'wrap', prefix: '**', suffix: '**', placeholder: 'bold' },
    },
    {
      icon: Italic,
      label: 'Italic',
      shortcut: 'Ctrl+I',
      action: { kind: 'wrap', prefix: '*', suffix: '*', placeholder: 'italic' },
    },
    {
      icon: Heading,
      label: 'Heading',
      action: { kind: 'linePrefix', prefix: '### ', placeholder: 'Heading' },
    },
    {
      icon: List,
      label: 'Bulleted list',
      action: { kind: 'linePrefix', prefix: '- ', placeholder: 'item' },
    },
    {
      icon: ListOrdered,
      label: 'Numbered list',
      action: { kind: 'linePrefix', prefix: '1. ', placeholder: 'item' },
    },
  ];

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label ? (
        <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {label}
        </label>
      ) : null}
      <div className="flex flex-wrap gap-1 rounded-t-md border border-b-0 bg-muted/40 px-1.5 py-1">
        {buttons.map((b) => {
          const Icon = b.icon;
          return (
            <button
              key={b.label}
              type="button"
              disabled={disabled}
              onClick={() => run(b.action)}
              title={b.shortcut ? `${b.label} (${b.shortcut})` : b.label}
              aria-label={b.label}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <Icon className="size-3.5" />
            </button>
          );
        })}
      </div>
      <Textarea
        id={id}
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        className="rounded-t-none font-mono text-xs"
      />
    </div>
  );
}
