'use client';

/**
 * Henry-suggested templates panel on /settings.
 *
 * Lists clusters of similar projects Henry has noticed in the
 * operator's recent history. Each row offers a one-click "Save as
 * template" — operator confirms, suggestion turns into a real
 * quote_templates row that picker UIs include.
 *
 * Per the rollup: AI as suggester. Henry surfaces the pattern;
 * operator decides whether it's worth saving.
 */

import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  getTemplateSuggestionsAction,
  saveSuggestedTemplateAction,
  type TemplateSuggestionCluster,
} from '@/server/actions/template-suggestions';

export function TemplateSuggestionsCard() {
  const [suggestions, setSuggestions] = useState<TemplateSuggestionCluster[] | null>(null);
  const [pending, startTransition] = useTransition();
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    getTemplateSuggestionsAction().then(setSuggestions);
  }, []);

  function save(cluster: TemplateSuggestionCluster) {
    startTransition(async () => {
      const res = await saveSuggestedTemplateAction({
        cluster_id: cluster.cluster_id,
        label: cluster.label,
        description: cluster.description,
        visibility: 'tenant',
        scaffold: cluster.scaffold,
      });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`Saved "${cluster.label}" as a template.`);
      setSavedIds((prev) => new Set(prev).add(cluster.cluster_id));
    });
  }

  // Hide the card entirely when there's nothing to suggest. Avoids
  // visual noise on settings for small tenants without history yet.
  if (suggestions !== null && suggestions.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Sparkles className="size-5" />
          <div>
            <CardTitle>Henry-suggested templates</CardTitle>
            <CardDescription>
              Patterns Henry noticed across your recent quotes. Save any of them as a template and
              they&rsquo;ll appear in the picker on new projects.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {suggestions === null ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> Looking for patterns&hellip;
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {suggestions.map((s) => {
              const saved = savedIds.has(s.cluster_id);
              return (
                <li
                  key={s.cluster_id}
                  className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.label}</p>
                    <p className="text-xs text-muted-foreground">{s.description}</p>
                    <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {s.project_count} similar projects · {s.scaffold.categories.length} categories
                      · {s.scaffold.categories.reduce((acc, b) => acc + b.lines.length, 0)} line
                      items
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => save(s)}
                    disabled={pending || saved}
                    variant={saved ? 'outline' : 'default'}
                  >
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
                    {saved ? 'Saved' : 'Save as template'}
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
