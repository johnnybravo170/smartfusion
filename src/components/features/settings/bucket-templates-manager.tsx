'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { upsertBucketTemplateAction, deleteBucketTemplateAction } from '@/server/actions/bucket-templates';

type TemplateRow = {
  id: string;
  name: string;
  section: 'interior' | 'exterior' | 'general';
  buckets: string[];
  is_default: boolean;
};

function TemplateForm({ initial, onDone }: { initial?: TemplateRow; onDone: () => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [name, setName] = useState(initial?.name ?? '');
  const [section, setSection] = useState<'interior' | 'exterior' | 'general'>(initial?.section ?? 'interior');
  const [bucketText, setBucketText] = useState(initial?.buckets.join('\n') ?? '');
  const [isDefault, setIsDefault] = useState(initial?.is_default ?? false);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    const buckets = bucketText.split('\n').map((b) => b.trim()).filter(Boolean);
    startTransition(async () => {
      const res = await upsertBucketTemplateAction({
        id: initial?.id,
        name,
        section,
        buckets,
        is_default: isDefault,
      });
      if (res.ok) onDone();
      else setError(res.error);
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 rounded-lg border bg-muted/30 p-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className="mb-1 block text-xs font-medium">Template Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bathroom Reno" required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium">Section</label>
          <select value={section} onChange={(e) => setSection(e.target.value as 'interior' | 'exterior' | 'general')} className="w-full rounded-md border bg-background px-3 py-2 text-sm">
            <option value="interior">Interior</option>
            <option value="exterior">Exterior</option>
            <option value="general">General</option>
          </select>
        </div>
        <div className="flex items-end pb-1">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} className="rounded" />
            Default template
          </label>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-xs font-medium">Buckets (one per line)</label>
        <textarea
          value={bucketText}
          onChange={(e) => setBucketText(e.target.value)}
          rows={6}
          placeholder={'Demo\nDisposal\nFraming\nPlumbing\nElectrical\nDrywall'}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm font-mono"
          required
        />
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={pending}>{pending ? 'Saving…' : initial ? 'Update' : 'Add template'}</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </form>
  );
}

export function BucketTemplatesManager({ templates }: { templates: TemplateRow[] }) {
  const [showForm, setShowForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TemplateRow | null>(null);
  const [, startTransition] = useTransition();

  function deleteTemplate(id: string) {
    if (!confirm('Delete this template?')) return;
    startTransition(async () => { await deleteBucketTemplateAction(id); });
  }

  return (
    <div className="space-y-4">
      {(showForm || editingTemplate) ? (
        <TemplateForm
          initial={editingTemplate ?? undefined}
          onDone={() => { setShowForm(false); setEditingTemplate(null); }}
        />
      ) : (
        <Button size="sm" onClick={() => setShowForm(true)}>+ Add template</Button>
      )}

      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground">No templates yet. Add your first bucket template above.</p>
      ) : (
        <div className="space-y-3">
          {templates.map((t) => (
            <div key={t.id} className="rounded-md border p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{t.name}</p>
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs capitalize">{t.section}</span>
                    {t.is_default && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">Default</span>}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{t.buckets.length} buckets: {t.buckets.slice(0, 5).join(', ')}{t.buckets.length > 5 ? ` +${t.buckets.length - 5} more` : ''}</p>
                </div>
                <div className="flex gap-1">
                  <Button size="xs" variant="ghost" onClick={() => { setEditingTemplate(t); setShowForm(false); }}>Edit</Button>
                  <Button size="xs" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => deleteTemplate(t.id)}>Del</Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
