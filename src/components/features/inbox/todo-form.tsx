'use client';

/**
 * Inline todo quick-add. Title-only by default; an expandable disclosure
 * shows due date + related link fields. On submit we call the server action
 * in a transition so the rest of the list remains responsive.
 */

import { ChevronDown, Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useHenryForm } from '@/hooks/use-henry-form';
import {
  type TodoRelatedType,
  todoRelatedTypeLabels,
  todoRelatedTypes,
} from '@/lib/validators/todo';
import { createTodoAction } from '@/server/actions/todos';

const UNSET = '__none';

export function TodoForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [title, setTitle] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [relatedType, setRelatedType] = useState<TodoRelatedType | typeof UNSET>(UNSET);
  const [relatedId, setRelatedId] = useState('');
  const [expanded, setExpanded] = useState(false);
  const titleId = useId();
  const dueId = useId();
  const relatedTypeId = useId();
  const relatedIdId = useId();

  useHenryForm({
    formId: 'todo-quick-add',
    title: 'Quick-adding a todo on the inbox',
    fields: [
      { name: 'title', label: 'Todo title', type: 'text', currentValue: title },
      {
        name: 'due_date',
        label: 'Due date (YYYY-MM-DD)',
        type: 'text',
        currentValue: dueDate,
      },
    ],
    setField: (name, value) => {
      if (name === 'title') {
        setTitle(value);
        return true;
      }
      if (name === 'due_date') {
        setDueDate(value);
        if (value) setExpanded(true);
        return true;
      }
      return false;
    },
    // Prefer the server-side create_todo tool for direct creates. The form
    // exists mostly so Henry CAN fill it when the operator is already on
    // the inbox and clearly wants to review before committing.
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      toast.error('Give your todo a title.');
      return;
    }
    startTransition(async () => {
      const result = await createTodoAction({
        title: trimmed,
        due_date: dueDate || undefined,
        related_type: relatedType === UNSET ? undefined : relatedType,
        related_id: relatedId || undefined,
      });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success('Todo added.');
      setTitle('');
      setDueDate('');
      setRelatedType(UNSET);
      setRelatedId('');
      setExpanded(false);
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-2 rounded-xl border bg-card p-3"
      aria-busy={pending || undefined}
    >
      <div className="flex gap-2">
        <Label htmlFor={titleId} className="sr-only">
          Todo
        </Label>
        <Input
          id={titleId}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add a todo…"
          autoComplete="off"
          disabled={pending}
        />
        <Button type="submit" disabled={pending || !title.trim()}>
          <Plus className="size-4" />
          {pending ? 'Adding…' : 'Add'}
        </Button>
      </div>

      <Collapsible open={expanded} onOpenChange={setExpanded}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1 self-start text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={`size-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
            {expanded ? 'Hide details' : 'Add due date or link'}
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={dueId} className="text-xs text-muted-foreground">
                Due date
              </Label>
              <Input
                id={dueId}
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                disabled={pending}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={relatedTypeId} className="text-xs text-muted-foreground">
                Related type
              </Label>
              <Select
                value={relatedType}
                onValueChange={(v) => setRelatedType(v as TodoRelatedType | typeof UNSET)}
                disabled={pending}
              >
                <SelectTrigger id={relatedTypeId}>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNSET}>None</SelectItem>
                  {todoRelatedTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {todoRelatedTypeLabels[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={relatedIdId} className="text-xs text-muted-foreground">
                Related id
              </Label>
              <Input
                id={relatedIdId}
                value={relatedId}
                onChange={(e) => setRelatedId(e.target.value)}
                placeholder="UUID"
                disabled={pending || relatedType === UNSET}
              />
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </form>
  );
}
