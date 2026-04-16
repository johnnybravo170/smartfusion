'use client';

/**
 * A single row in the todo list. Toggling the checkbox fires
 * `toggleTodoAction` in a transition. The delete icon is revealed on hover
 * (always visible on touch). A due-date pill uses a colour coded by
 * proximity: red for overdue, amber for today, muted for upcoming.
 */

import { Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { TodoRow } from '@/lib/db/queries/todos';
import { cn } from '@/lib/utils';
import { type TodoRelatedType, todoRelatedTypeLabels } from '@/lib/validators/todo';
import { deleteTodoAction, toggleTodoAction } from '@/server/actions/todos';
import { formatDueDate, todoDueBucket } from './relative-time';

const DUE_STYLES: Record<'overdue' | 'today' | 'upcoming' | 'none', string> = {
  overdue: 'bg-destructive/10 text-destructive border-destructive/20',
  today: 'bg-amber-100 text-amber-800 border-amber-200',
  upcoming: 'bg-muted text-muted-foreground border-muted-foreground/20',
  none: '',
};

export function TodoItem({ todo }: { todo: TodoRow }) {
  const router = useRouter();
  const [togglePending, startToggle] = useTransition();
  const [deletePending, startDelete] = useTransition();
  const bucket = todoDueBucket(todo.due_date);

  function onToggle(checked: boolean) {
    startToggle(async () => {
      const result = await toggleTodoAction({ id: todo.id, done: checked });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      router.refresh();
    });
  }

  function onDelete(event: React.MouseEvent) {
    event.preventDefault();
    startDelete(async () => {
      const result = await deleteTodoAction(todo.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Todo deleted.');
      router.refresh();
    });
  }

  return (
    <div
      data-slot="todo-item"
      data-done={todo.done ? 'true' : 'false'}
      className="group flex items-start gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-muted/30"
    >
      <Checkbox
        checked={todo.done}
        onCheckedChange={(value) => onToggle(value === true)}
        disabled={togglePending}
        aria-label={todo.done ? 'Mark as not done' : 'Mark as done'}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className={cn(
            'text-sm',
            todo.done ? 'text-muted-foreground line-through' : 'text-foreground',
          )}
        >
          {todo.title}
        </span>
        {(todo.due_date || todo.related_type) && (
          <div className="flex flex-wrap items-center gap-2">
            {todo.due_date ? (
              <Badge variant="outline" className={cn('font-medium border', DUE_STYLES[bucket])}>
                {formatDueDate(todo.due_date)}
              </Badge>
            ) : null}
            {todo.related_type ? (
              <Badge variant="outline" className="text-xs">
                {todoRelatedTypeLabels[todo.related_type as TodoRelatedType]}
              </Badge>
            ) : null}
          </div>
        )}
      </div>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Delete todo"
            className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
            disabled={deletePending}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this todo?</AlertDialogTitle>
            <AlertDialogDescription>
              The todo will be removed immediately. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deletePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onDelete}
              disabled={deletePending}
              className="bg-destructive/10 text-destructive hover:bg-destructive/20"
            >
              {deletePending ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
