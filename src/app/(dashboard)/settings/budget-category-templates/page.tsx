import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { BudgetCategoryTemplatesManager } from '@/components/features/settings/budget-category-templates-manager';
import { createClient } from '@/lib/supabase/server';

export const metadata = { title: 'Budget Category Templates — HeyHenry' };

export default async function BudgetCategoryTemplatesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from('budget_category_templates')
    .select('id, name, section, categories, is_default')
    .order('name');

  const templates = (data ?? []).map((t) => ({
    id: t.id as string,
    name: t.name as string,
    section: t.section as 'interior' | 'exterior' | 'general',
    categories: (t.categories as string[]) ?? [],
    is_default: (t.is_default as boolean) ?? false,
  }));

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link
          href="/settings"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Back to settings
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">Budget Category Templates</h1>
        <p className="text-sm text-muted-foreground">
          Reusable budget category sets for renovation projects. Applied when creating a new
          project.
        </p>
      </header>

      <BudgetCategoryTemplatesManager templates={templates} />
    </div>
  );
}
