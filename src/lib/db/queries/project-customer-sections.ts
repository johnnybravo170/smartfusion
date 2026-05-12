import { createClient } from '@/lib/supabase/server';

export type CustomerSectionRow = {
  id: string;
  project_id: string;
  tenant_id: string;
  name: string;
  description_md: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export async function listCustomerSectionsForProject(
  projectId: string,
): Promise<CustomerSectionRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('project_customer_sections')
    .select('id, project_id, tenant_id, name, description_md, sort_order, created_at, updated_at')
    .eq('project_id', projectId)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to list customer sections: ${error.message}`);
  return (data ?? []) as CustomerSectionRow[];
}
