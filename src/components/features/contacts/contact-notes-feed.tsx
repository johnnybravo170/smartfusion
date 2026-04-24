'use client';

/**
 * Notes feed for a contact — read/add/edit/delete entries on the
 * `contact_notes` table. Author + timestamp shown per entry. System-
 * migrated notes (from the legacy `customers.notes` blob) are marked
 * so they're easy to tell apart from new operator-authored ones.
 */

import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { formatDate } from '@/lib/date/format';
import {
  addContactNoteAction,
  deleteContactNoteAction,
  editContactNoteAction,
} from '@/server/actions/contact-notes';

export type ContactNotesFeedNote = {
  id: string;
  body: string;
  authorType: 'operator' | 'worker' | 'henry' | 'customer' | 'system';
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

const AUTHOR_LABELS: Record<ContactNotesFeedNote['authorType'], string> = {
  operator: 'You',
  worker: 'Crew',
  henry: 'Henry',
  customer: 'Customer',
  system: 'Imported',
};

export function ContactNotesFeed({
  contactId,
  notes: initialNotes,
  timezone,
}: {
  contactId: string;
  notes: ContactNotesFeedNote[];
  timezone: string;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState('');
  const [pending, startTransition] = useTransition();

  function handleAdd() {
    const body = draft.trim();
    if (!body) return;
    startTransition(async () => {
      const res = await addContactNoteAction({ contactId, body });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Optimistic local insert so the list updates without waiting for the
      // server revalidation to stream back.
      const now = new Date().toISOString();
      setNotes((prev) => [
        {
          id: res.id,
          body,
          authorType: 'operator',
          metadata: {},
          createdAt: now,
          updatedAt: now,
        },
        ...prev,
      ]);
      setDraft('');
    });
  }

  function startEdit(note: ContactNotesFeedNote) {
    setEditingId(note.id);
    setEditingDraft(note.body);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditingDraft('');
  }

  function saveEdit(noteId: string) {
    const body = editingDraft.trim();
    if (!body) return;
    startTransition(async () => {
      const res = await editContactNoteAction({ noteId, body });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      const now = new Date().toISOString();
      setNotes((prev) => prev.map((n) => (n.id === noteId ? { ...n, body, updatedAt: now } : n)));
      cancelEdit();
    });
  }

  function handleDelete(noteId: string) {
    if (!confirm('Delete this note? This cannot be undone.')) return;
    startTransition(async () => {
      const res = await deleteContactNoteAction(noteId);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setNotes((prev) => prev.filter((n) => n.id !== noteId));
    });
  }

  return (
    <section className="rounded-xl border bg-card">
      <header className="flex items-center justify-between border-b px-5 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Notes
        </h2>
        <span className="text-xs text-muted-foreground">
          {notes.length} {notes.length === 1 ? 'entry' : 'entries'}
        </span>
      </header>

      <div className="space-y-3 p-5">
        <div className="flex flex-col gap-2">
          <Textarea
            rows={3}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note — conversation, photo, reminder, anything worth remembering."
            disabled={pending}
          />
          <div className="flex justify-end">
            <Button type="button" size="sm" onClick={handleAdd} disabled={pending || !draft.trim()}>
              {pending ? (
                <>
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                'Add note'
              )}
            </Button>
          </div>
        </div>

        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        ) : (
          <ul className="divide-y border-t pt-2">
            {notes.map((note) => {
              const isEditing = editingId === note.id;
              const isSystem = note.authorType === 'system';
              const importedFromLegacy =
                isSystem &&
                (note.metadata as { source?: string }).source === 'imported_from_notes_field';
              return (
                <li key={note.id} className="flex flex-col gap-1 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {AUTHOR_LABELS[note.authorType]}
                      </span>
                      <span>·</span>
                      <time dateTime={note.createdAt}>
                        {formatDate(note.createdAt, { timezone })}
                      </time>
                      {importedFromLegacy ? (
                        <>
                          <span>·</span>
                          <span className="rounded-full bg-muted px-2 py-0.5">
                            migrated from notes field
                          </span>
                        </>
                      ) : null}
                    </div>
                    {!isEditing ? (
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => startEdit(note)}
                          disabled={pending}
                          aria-label="Edit note"
                        >
                          <Pencil className="size-3" />
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => handleDelete(note.id)}
                          disabled={pending}
                          aria-label="Delete note"
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                  {isEditing ? (
                    <div className="flex flex-col gap-2">
                      <Textarea
                        rows={3}
                        value={editingDraft}
                        onChange={(e) => setEditingDraft(e.target.value)}
                        disabled={pending}
                      />
                      <div className="flex justify-end gap-2">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={cancelEdit}
                          disabled={pending}
                        >
                          Cancel
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          onClick={() => saveEdit(note.id)}
                          disabled={pending || !editingDraft.trim()}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
                      {note.body}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
