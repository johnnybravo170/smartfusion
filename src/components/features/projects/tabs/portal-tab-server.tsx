import { DecisionForm } from '@/components/features/portal/decision-form';
import { DecisionList } from '@/components/features/portal/decision-list';
import { DecisionSuggestions } from '@/components/features/portal/decision-suggestions';
import { PhaseRail } from '@/components/features/portal/phase-rail';
import { PortalBudgetVisibilityToggle } from '@/components/features/portal/portal-budget-visibility-toggle';
import { PortalToggle } from '@/components/features/portal/portal-toggle';
import { PortalUpdateForm } from '@/components/features/portal/portal-update-form';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { listDecisionsForProject } from '@/lib/db/queries/project-decisions';
import { listPhasesForProject } from '@/lib/db/queries/project-phases';
import { createClient } from '@/lib/supabase/server';

export default async function PortalTabServer({ projectId }: { projectId: string }) {
  const supabase = await createClient();

  const tenant = await getCurrentTenant();
  const [
    { data: portalUpdates },
    { data: portalData },
    phases,
    decisions,
    { data: tenantSettings },
  ] = await Promise.all([
    supabase
      .from('project_portal_updates')
      .select('id, type, title, body, photo_url, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('projects')
      .select('portal_slug, portal_enabled, portal_show_budget')
      .eq('id', projectId)
      .single(),
    listPhasesForProject(projectId),
    listDecisionsForProject(projectId),
    tenant
      ? supabase.from('tenants').select('portal_show_budget').eq('id', tenant.id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const portalEnabled = (portalData?.portal_enabled as boolean) ?? false;
  const portalSlug = (portalData?.portal_slug as string | null) ?? null;
  const portalShowBudget = (portalData?.portal_show_budget as boolean | null | undefined) ?? null;
  const tenantShowBudget = Boolean(tenantSettings?.portal_show_budget);

  return (
    <div className="space-y-6">
      <PortalToggle projectId={projectId} portalEnabled={portalEnabled} portalSlug={portalSlug} />

      {portalEnabled ? (
        <div className="rounded-lg border bg-card p-4">
          <PortalBudgetVisibilityToggle
            projectId={projectId}
            initialValue={portalShowBudget}
            tenantDefault={tenantShowBudget}
          />
        </div>
      ) : null}

      {phases.length > 0 ? <PhaseRail phases={phases} projectId={projectId} /> : null}

      <div className="rounded-lg border bg-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Decision queue</h3>
            <p className="text-xs text-muted-foreground">
              Ask the homeowner to approve / decline / question something — pinned to the top of
              their portal.
            </p>
          </div>
          <DecisionForm projectId={projectId} />
        </div>
        <DecisionList decisions={decisions} projectId={projectId} />
        <DecisionSuggestions projectId={projectId} />
      </div>

      {portalEnabled ? (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Portal Updates</h3>
            <PortalUpdateForm projectId={projectId} />
          </div>

          {(portalUpdates ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No portal updates yet.</p>
          ) : (
            <div className="space-y-3">
              {(portalUpdates ?? []).map((u) => {
                const ud = u as Record<string, unknown>;
                return (
                  <div key={ud.id as string} className="rounded-md border p-3">
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                        {ud.type as string}
                      </span>
                      <span className="text-sm font-medium">{ud.title as string}</span>
                      <span className="ml-auto text-xs text-muted-foreground">
                        {new Date(ud.created_at as string).toLocaleDateString('en-CA', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>
                    {ud.body ? (
                      <p className="mt-1 text-sm text-muted-foreground">{ud.body as string}</p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
