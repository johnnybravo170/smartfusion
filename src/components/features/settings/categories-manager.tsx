'use client';

/**
 * Expense categories manager.
 *
 * Flat tree: parents at top, children indented one level under them.
 * Inline rename on click. Optional account_code column, hidden unless
 * the tenant flips the "Show account codes" toggle (the hidden column
 * is for contractors whose bookkeeper wants to pre-map to their own
 * chart of accounts).
 *
 * Archive-not-delete so historical expenses keep their FK. Archiving
 * a parent archives its children automatically (server-side).
 */

import { Archive, ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ExpenseCategoryTreeNode } from '@/lib/db/queries/expense-categories';
import {
  archiveExpenseCategoryAction,
  createExpenseCategoryAction,
  setShowAccountCodesAction,
  updateExpenseCategoryAction,
} from '@/server/actions/expense-categories';

type Props = {
  tree: ExpenseCategoryTreeNode[];
  showAccountCodes: boolean;
};

export function CategoriesManager({ tree, showAccountCodes: initialShow }: Props) {
  const [showCodes, setShowCodes] = useState(initialShow);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.map((n) => n.id)));
  const [addingChildFor, setAddingChildFor] = useState<string | null>(null);
  const [newParentName, setNewParentName] = useState('');
  const [newChildName, setNewChildName] = useState('');
  const [pending, startTransition] = useTransition();

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function addParent() {
    const name = newParentName.trim();
    if (!name) return;
    startTransition(async () => {
      const res = await createExpenseCategoryAction({ name });
      if (!res.ok) toast.error(res.error);
      else setNewParentName('');
    });
  }

  function addChild(parentId: string) {
    const name = newChildName.trim();
    if (!name) return;
    startTransition(async () => {
      const res = await createExpenseCategoryAction({ name, parent_id: parentId });
      if (!res.ok) toast.error(res.error);
      else {
        setNewChildName('');
        setAddingChildFor(null);
      }
    });
  }

  function archive(id: string, name: string) {
    if (!confirm(`Archive "${name}"? It won't appear on new expenses but old ones keep the tag.`))
      return;
    startTransition(async () => {
      const res = await archiveExpenseCategoryAction({ id });
      if (!res.ok) toast.error(res.error);
    });
  }

  function onToggleShowCodes(v: boolean) {
    setShowCodes(v);
    startTransition(async () => {
      const res = await setShowAccountCodesAction({ show: v });
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between rounded-md border bg-muted/30 px-4 py-3">
        <div>
          <Label htmlFor="show-codes" className="text-sm font-medium">
            Show account codes
          </Label>
          <p className="text-xs text-muted-foreground">
            Optional — for mapping to your bookkeeper&apos;s chart of accounts.
          </p>
        </div>
        <Checkbox
          id="show-codes"
          checked={showCodes}
          onCheckedChange={(v) => onToggleShowCodes(v === true)}
        />
      </div>

      <div className="rounded-md border">
        <div className="border-b bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground">
          Categories
        </div>

        <div>
          {tree.map((parent) => {
            const isOpen = expanded.has(parent.id);
            const hasChildren = parent.children.length > 0;
            return (
              <div key={parent.id} className="border-b last:border-0">
                <CategoryRow
                  id={parent.id}
                  name={parent.name}
                  accountCode={parent.account_code}
                  showCodes={showCodes}
                  onArchive={() => archive(parent.id, parent.name)}
                  pending={pending}
                  leading={
                    <button
                      type="button"
                      onClick={() => toggleExpand(parent.id)}
                      className="text-muted-foreground hover:text-foreground"
                      aria-label={isOpen ? 'Collapse' : 'Expand'}
                    >
                      {isOpen ? (
                        <ChevronDown className="size-4" />
                      ) : (
                        <ChevronRight className="size-4" />
                      )}
                    </button>
                  }
                  trailing={
                    <button
                      type="button"
                      onClick={() =>
                        setAddingChildFor(addingChildFor === parent.id ? null : parent.id)
                      }
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    >
                      <Plus className="size-3.5" />
                      Sub-account
                    </button>
                  }
                />

                {isOpen && hasChildren ? (
                  <div className="bg-muted/10">
                    {parent.children.map((child) => (
                      <CategoryRow
                        key={child.id}
                        id={child.id}
                        name={child.name}
                        accountCode={child.account_code}
                        showCodes={showCodes}
                        onArchive={() => archive(child.id, child.name)}
                        pending={pending}
                        indent
                      />
                    ))}
                  </div>
                ) : null}

                {addingChildFor === parent.id ? (
                  <div className="flex items-center gap-2 border-t bg-muted/20 px-4 py-2 pl-10">
                    <Input
                      value={newChildName}
                      onChange={(e) => setNewChildName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') addChild(parent.id);
                        if (e.key === 'Escape') {
                          setAddingChildFor(null);
                          setNewChildName('');
                        }
                      }}
                      placeholder={`New sub-account under ${parent.name}`}
                      className="h-8 text-sm"
                      autoFocus
                    />
                    <Button size="sm" onClick={() => addChild(parent.id)} disabled={pending}>
                      Add
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setAddingChildFor(null);
                        setNewChildName('');
                      }}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="flex items-center gap-2 border-t bg-muted/20 px-4 py-2">
          <Input
            value={newParentName}
            onChange={(e) => setNewParentName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addParent();
            }}
            placeholder="New category"
            className="h-8 text-sm"
          />
          <Button size="sm" onClick={addParent} disabled={pending || !newParentName.trim()}>
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}

function CategoryRow({
  id,
  name,
  accountCode,
  showCodes,
  onArchive,
  pending,
  leading,
  trailing,
  indent,
}: {
  id: string;
  name: string;
  accountCode: string | null;
  showCodes: boolean;
  onArchive: () => void;
  pending: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  indent?: boolean;
}) {
  return (
    <div className={`flex items-center gap-3 px-4 py-2 ${indent ? 'pl-10' : ''}`}>
      <div className="w-4">{leading}</div>
      <InlineText id={id} field="name" value={name} pending={pending} className="flex-1" />
      {showCodes ? (
        <InlineText
          id={id}
          field="account_code"
          value={accountCode ?? ''}
          placeholder="Code"
          pending={pending}
          className="w-28"
        />
      ) : null}
      {trailing}
      <button
        type="button"
        onClick={onArchive}
        disabled={pending}
        className="text-muted-foreground hover:text-red-600 disabled:opacity-50"
        aria-label={`Archive ${name}`}
      >
        <Archive className="size-3.5" />
      </button>
    </div>
  );
}

function InlineText({
  id,
  field,
  value,
  pending,
  placeholder,
  className,
}: {
  id: string;
  field: 'name' | 'account_code';
  value: string;
  pending: boolean;
  placeholder?: string;
  className?: string;
}) {
  const [current, setCurrent] = useState(value);
  const [focused, setFocused] = useState(false);

  function commit() {
    if (current === value) return;
    // We're deliberately optimistic — the parent revalidates the page,
    // which will re-seed `value` from server truth on next render.
    if (field === 'name' && !current.trim()) {
      setCurrent(value);
      return;
    }
    updateExpenseCategoryAction({ id, [field]: current.trim() }).then((res) => {
      if (!res.ok) toast.error(res.error);
    });
  }

  return (
    <input
      type="text"
      value={focused ? current : value}
      onChange={(e) => setCurrent(e.target.value)}
      onFocus={() => {
        setCurrent(value);
        setFocused(true);
      }}
      onBlur={() => {
        setFocused(false);
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setCurrent(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      disabled={pending}
      placeholder={placeholder}
      className={`rounded-sm bg-transparent px-1.5 py-0.5 text-sm outline-none focus:bg-background focus:ring-1 focus:ring-ring ${className ?? ''}`}
    />
  );
}
