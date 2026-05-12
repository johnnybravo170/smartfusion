'use client';

import { ArrowDown, ArrowUp, Layers, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  assignCategoryToSectionAction,
  createCustomerSectionAction,
  deleteCustomerSectionAction,
  reorderCustomerSectionsAction,
  updateCustomerSectionAction,
} from '@/server/actions/project-customer-view';

type Section = {
  id: string;
  name: string;
  description_md: string | null;
  sort_order: number;
};

type Category = {
  id: string;
  name: string;
  customer_section_id: string | null;
};

type Props = {
  projectId: string;
  sections: Section[];
  categories: Category[];
};

export function CustomerSectionsManager({
  projectId,
  sections: initialSections,
  categories: initialCategories,
}: Props) {
  const [sections, setSections] = useState<Section[]>(initialSections);
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [newName, setNewName] = useState('');
  const [pending, startTransition] = useTransition();

  const unassignedCategories = useMemo(
    () => categories.filter((c) => !c.customer_section_id),
    [categories],
  );

  function handleCreate() {
    const name = newName.trim();
    if (!name) {
      toast.error('Give the section a name.');
      return;
    }
    startTransition(async () => {
      const res = await createCustomerSectionAction({ projectId, name });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSections((prev) => [
        ...prev,
        {
          id: res.id,
          name,
          description_md: null,
          sort_order: prev.length,
        },
      ]);
      setNewName('');
      toast.success('Section added.');
    });
  }

  function handleUpdate(id: string, patch: { name?: string; descriptionMd?: string | null }) {
    startTransition(async () => {
      const res = await updateCustomerSectionAction({ id, ...patch });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSections((prev) =>
        prev.map((s) =>
          s.id === id
            ? {
                ...s,
                name: patch.name ?? s.name,
                description_md:
                  patch.descriptionMd !== undefined ? patch.descriptionMd : s.description_md,
              }
            : s,
        ),
      );
    });
  }

  function handleDelete(id: string) {
    if (!confirm('Delete this section? Categories assigned to it will be unassigned.')) return;
    startTransition(async () => {
      const res = await deleteCustomerSectionAction({ id });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSections((prev) => prev.filter((s) => s.id !== id));
      setCategories((prev) =>
        prev.map((c) => (c.customer_section_id === id ? { ...c, customer_section_id: null } : c)),
      );
      toast.success('Section deleted.');
    });
  }

  function handleReorder(index: number, direction: 'up' | 'down') {
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= sections.length) return;
    const reordered = [...sections];
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];
    setSections(reordered);
    startTransition(async () => {
      const res = await reorderCustomerSectionsAction({
        projectId,
        sectionIds: reordered.map((s) => s.id),
      });
      if (!res.ok) {
        toast.error(res.error);
        // Best-effort revert
        setSections(sections);
      }
    });
  }

  function handleAssignCategory(categoryId: string, sectionId: string | null) {
    startTransition(async () => {
      const res = await assignCategoryToSectionAction({ categoryId, sectionId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setCategories((prev) =>
        prev.map((c) => (c.id === categoryId ? { ...c, customer_section_id: sectionId } : c)),
      );
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Layers className="size-5" />
          <div>
            <CardTitle>Customer sections</CardTitle>
            <CardDescription>
              Group categories under customer-facing names (e.g. "Bathroom Remodel"). Only visible
              to the customer when Customer view is set to <em>Sections</em>.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add new section */}
        <div className="flex items-center gap-2">
          <Input
            placeholder="New section name (e.g. Bathroom Remodel)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleCreate();
              }
            }}
            disabled={pending}
            className="flex-1"
          />
          <Button onClick={handleCreate} size="sm" disabled={pending || !newName.trim()}>
            <Plus className="mr-1 size-4" />
            Add
          </Button>
        </div>

        {/* Section list */}
        {sections.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No sections yet. Add a few customer-facing groupings above.
          </p>
        ) : (
          <ul className="space-y-3">
            {sections.map((section, idx) => {
              const assignedCategories = categories.filter(
                (c) => c.customer_section_id === section.id,
              );
              return (
                <li key={section.id} className="rounded-md border bg-card p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => handleReorder(idx, 'up')}
                        disabled={pending || idx === 0}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                        aria-label="Move up"
                      >
                        <ArrowUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReorder(idx, 'down')}
                        disabled={pending || idx === sections.length - 1}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                        aria-label="Move down"
                      >
                        <ArrowDown className="size-3.5" />
                      </button>
                    </div>
                    <div className="flex-1 min-w-0 space-y-2">
                      <Input
                        defaultValue={section.name}
                        onBlur={(e) => {
                          const next = e.target.value.trim();
                          if (next && next !== section.name) {
                            handleUpdate(section.id, { name: next });
                          }
                        }}
                        className="font-medium"
                        disabled={pending}
                      />
                      <Textarea
                        placeholder="What's included in this section (shown to customer in Sections mode)"
                        defaultValue={section.description_md ?? ''}
                        onBlur={(e) => {
                          const next = e.target.value;
                          const prev = section.description_md ?? '';
                          if (next !== prev) {
                            handleUpdate(section.id, { descriptionMd: next || null });
                          }
                        }}
                        rows={2}
                        disabled={pending}
                      />
                      <div className="space-y-1.5">
                        <Label className="text-xs text-muted-foreground">
                          Categories in this section
                        </Label>
                        <div className="flex flex-wrap gap-1.5">
                          {assignedCategories.length === 0 ? (
                            <span className="text-xs italic text-muted-foreground">
                              No categories assigned.
                            </span>
                          ) : (
                            assignedCategories.map((c) => (
                              <button
                                key={c.id}
                                type="button"
                                onClick={() => handleAssignCategory(c.id, null)}
                                disabled={pending}
                                className="inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 text-xs hover:bg-destructive/10 hover:text-destructive"
                                title="Remove from section"
                              >
                                {c.name}
                                <span className="text-muted-foreground">×</span>
                              </button>
                            ))
                          )}
                        </div>
                        {unassignedCategories.length > 0 ? (
                          <select
                            value=""
                            onChange={(e) => {
                              if (e.target.value) {
                                handleAssignCategory(e.target.value, section.id);
                              }
                            }}
                            disabled={pending}
                            className="block w-full rounded-md border bg-background px-2 py-1 text-xs"
                          >
                            <option value="">+ Assign category…</option>
                            {unassignedCategories.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        ) : null}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleDelete(section.id)}
                      disabled={pending}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      aria-label="Delete section"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
