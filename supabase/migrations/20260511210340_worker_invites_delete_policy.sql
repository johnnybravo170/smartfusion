-- Allow tenant members to delete invites in their tenant.
-- Owner/admin enforcement happens in the server action (deleteInviteAction);
-- without this policy the RLS-aware client silently deletes 0 rows.

CREATE POLICY tenant_delete_worker_invites ON public.worker_invites
    FOR DELETE TO authenticated
    USING (tenant_id = public.current_tenant_id());
