'use client';

/**
 * Unified Notes feed for a project. One chronological list mixing:
 *   - Operator notes (plain text)
 *   - Voice memos (audio + transcript)
 *   - System / intake events from worklog_entries
 *
 * "Leave a memo" still works (existing MemoUpload), tucked behind a
 * button so the primary surface is the feed and the inline note input.
 */

import {
  Bot,
  Loader2,
  MessageSquare,
  Mic,
  Send,
  Sparkles,
  StickyNote,
  Trash2,
  User as UserIcon,
} from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { MemoUpload, type MemoUploadProps } from '@/components/features/memos/memo-upload';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  addProjectNoteAction,
  askHenryAboutProjectAction,
  deleteProjectNoteAction,
} from '@/server/actions/project-notes';

export type NoteFeedItem =
  | {
      kind: 'note';
      id: string;
      created_at: string;
      body: string;
      author_name: string | null;
    }
  | {
      kind: 'reply_draft';
      id: string;
      created_at: string;
      body: string;
    }
  | {
      kind: 'henry_q';
      id: string;
      created_at: string;
      body: string;
    }
  | {
      kind: 'henry_a';
      id: string;
      created_at: string;
      body: string;
    }
  | {
      kind: 'memo';
      id: string;
      created_at: string;
      transcript: string | null;
      status: string;
    }
  | {
      kind: 'event';
      id: string;
      created_at: string;
      title: string | null;
      body: string | null;
      entry_type: string;
    };

export function ProjectNotesTab({
  projectId,
  feed,
  memoUploadProps,
}: {
  projectId: string;
  feed: NoteFeedItem[];
  /** Props passed straight to MemoUpload (memos list, photos, etc). */
  memoUploadProps: MemoUploadProps;
}) {
  const [draft, setDraft] = useState('');
  const [henryQ, setHenryQ] = useState('');
  const [isAdding, startAdding] = useTransition();
  const [isAsking, startAsking] = useTransition();
  const [isDeleting, startDeleting] = useTransition();
  const [memoOpen, setMemoOpen] = useState(false);

  function handleAdd() {
    const body = draft.trim();
    if (!body) return;
    startAdding(async () => {
      const res = await addProjectNoteAction({ projectId, body });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setDraft('');
      toast.success('Note added');
    });
  }

  function handleAskHenry() {
    const q = henryQ.trim();
    if (!q) return;
    startAsking(async () => {
      const res = await askHenryAboutProjectAction({ projectId, question: q });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setHenryQ('');
    });
  }

  function handleDelete(noteId: string) {
    if (!confirm('Delete this note?')) return;
    startDeleting(async () => {
      const res = await deleteProjectNoteAction({ noteId, projectId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Inline note composer */}
      <div className="rounded-md border bg-card p-3">
        <Textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note about this project…"
          className="border-0 px-0 py-1 text-sm focus-visible:ring-0"
        />
        <div className="mt-2 flex items-center justify-between">
          <Dialog open={memoOpen} onOpenChange={setMemoOpen}>
            <DialogTrigger asChild>
              <Button size="sm" variant="ghost" className="gap-1.5">
                <Mic className="size-3.5" />
                Voice memo
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Record a voice memo</DialogTitle>
              </DialogHeader>
              <MemoUpload {...memoUploadProps} />
            </DialogContent>
          </Dialog>
          <Button size="sm" onClick={handleAdd} disabled={isAdding || !draft.trim()}>
            {isAdding ? (
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

      {/* Ask Henry */}
      <div className="rounded-md border bg-muted/10 p-3">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          <Bot className="size-3.5" />
          Ask Henry about this project
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            rows={1}
            value={henryQ}
            onChange={(e) => setHenryQ(e.target.value)}
            placeholder="e.g. What's the biggest variance risk on this job?"
            className="border-0 px-0 py-1 text-sm focus-visible:ring-0"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleAskHenry();
              }
            }}
          />
          <Button
            size="sm"
            onClick={handleAskHenry}
            disabled={isAsking || !henryQ.trim()}
            className="gap-1.5"
          >
            {isAsking ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
            Ask
          </Button>
        </div>
      </div>

      {/* Feed */}
      {feed.length === 0 ? (
        <p className="rounded-md border bg-muted/20 px-4 py-8 text-center text-sm text-muted-foreground">
          No notes yet. Add a note above, record a memo, or drop artifacts via "Add to project".
        </p>
      ) : (
        <ol className="space-y-3">
          {feed.map((item) => (
            <li key={`${item.kind}-${item.id}`}>
              {item.kind === 'note' ? (
                <NoteCard
                  body={item.body}
                  author={item.author_name}
                  createdAt={item.created_at}
                  onDelete={() => handleDelete(item.id)}
                  isDeleting={isDeleting}
                />
              ) : item.kind === 'reply_draft' ? (
                <ReplyDraftCard
                  body={item.body}
                  createdAt={item.created_at}
                  onDelete={() => handleDelete(item.id)}
                  isDeleting={isDeleting}
                />
              ) : item.kind === 'henry_q' ? (
                <ChatCard
                  speaker="user"
                  body={item.body}
                  createdAt={item.created_at}
                  onDelete={() => handleDelete(item.id)}
                  isDeleting={isDeleting}
                />
              ) : item.kind === 'henry_a' ? (
                <ChatCard
                  speaker="henry"
                  body={item.body}
                  createdAt={item.created_at}
                  onDelete={() => handleDelete(item.id)}
                  isDeleting={isDeleting}
                />
              ) : item.kind === 'memo' ? (
                <MemoCard
                  transcript={item.transcript}
                  status={item.status}
                  createdAt={item.created_at}
                />
              ) : (
                <EventCard
                  title={item.title}
                  body={item.body}
                  entryType={item.entry_type}
                  createdAt={item.created_at}
                />
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function NoteCard({
  body,
  author,
  createdAt,
  onDelete,
  isDeleting,
}: {
  body: string;
  author: string | null;
  createdAt: string;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-start gap-2">
        <StickyNote className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="whitespace-pre-wrap text-sm">{body}</p>
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>{author ?? 'Note'}</span>
            <span>·</span>
            <span>{formatWhen(createdAt)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          aria-label="Delete note"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function ReplyDraftCard({
  body,
  createdAt,
  onDelete,
  isDeleting,
}: {
  body: string;
  createdAt: string;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  function copy() {
    navigator.clipboard.writeText(body).then(() => toast.success('Reply copied'));
  }
  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 p-3">
      <div className="flex items-start gap-2">
        <MessageSquare className="mt-0.5 size-3.5 shrink-0 text-amber-700" />
        <div className="min-w-0 flex-1">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-amber-800">
            Henry drafted a reply
          </p>
          <p className="whitespace-pre-wrap text-sm text-amber-950">{body}</p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="xs" variant="outline" onClick={copy} className="bg-white">
              Copy reply
            </Button>
            <span className="text-[10px] text-amber-700/80">{formatWhen(createdAt)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          aria-label="Delete reply draft"
          className="text-amber-700/60 hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function ChatCard({
  speaker,
  body,
  createdAt,
  onDelete,
  isDeleting,
}: {
  speaker: 'user' | 'henry';
  body: string;
  createdAt: string;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const isUser = speaker === 'user';
  return (
    <div className={`rounded-md border p-3 ${isUser ? 'bg-card' : 'border-blue-200 bg-blue-50'}`}>
      <div className="flex items-start gap-2">
        {isUser ? (
          <UserIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Bot className="mt-0.5 size-3.5 shrink-0 text-blue-700" />
        )}
        <div className="min-w-0 flex-1">
          <p className={`whitespace-pre-wrap text-sm ${isUser ? '' : 'text-blue-950'}`}>{body}</p>
          <div
            className={`mt-1 flex items-center gap-2 text-[10px] ${isUser ? 'text-muted-foreground' : 'text-blue-700/80'}`}
          >
            <span>{isUser ? 'You asked' : 'Henry'}</span>
            <span>·</span>
            <span>{formatWhen(createdAt)}</span>
          </div>
        </div>
        <button
          type="button"
          onClick={onDelete}
          disabled={isDeleting}
          aria-label="Delete"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function MemoCard({
  transcript,
  status,
  createdAt,
}: {
  transcript: string | null;
  status: string;
  createdAt: string;
}) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="flex items-start gap-2">
        <Mic className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {transcript ? (
            <p className="whitespace-pre-wrap text-sm">{transcript}</p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              {status === 'transcribing' ? 'Transcribing…' : 'Audio memo'}
            </p>
          )}
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>Memo</span>
            <span>·</span>
            <span>{formatWhen(createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function EventCard({
  title,
  body,
  entryType,
  createdAt,
}: {
  title: string | null;
  body: string | null;
  entryType: string;
  createdAt: string;
}) {
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          {title ? <p className="text-sm font-medium">{title}</p> : null}
          {body ? <p className="text-xs text-muted-foreground">{body}</p> : null}
          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
            <span className="capitalize">{entryType}</span>
            <span>·</span>
            <span>{formatWhen(createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-CA', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
