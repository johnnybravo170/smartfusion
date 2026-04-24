-- 0119_task_notifications.sql
-- Simple notifications table used by Phase 3 of the Tasks module as a
-- stand-in for real push infrastructure (Twilio / Expo / webpush). Each
-- row represents a single notification — task assignment to a worker,
-- a worker marking done/blocked for the owner, a "Need Help" ping.
--
-- Push infra will later consume unread rows and deliver them. For now,
-- the rows exist so the data path is wired end-to-end and a future
-- follow-up only needs to add the delivery side.
--
-- Tenant-scoped; RLS lets a user see their own rows and lets owners/
-- admins read any notification within the tenant so a dashboard can
-- surface "what pinged your crew today" later.

CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants (id) ON DELETE CASCADE,

  -- Recipient (auth.users.id). Nullable so a broadcast-style "all owners"
  -- notification can be stored without a specific target.
  recipient_user_id UUID REFERENCES auth.users (id) ON DELETE CASCADE,

  kind TEXT NOT NULL
    CHECK (kind IN (
      'task_assigned',
      'task_done',
      'task_blocked',
      'task_help',
      'task_verified',
      'task_rejected'
    )),

  -- What the notification is about.
  task_id UUID REFERENCES public.tasks (id) ON DELETE CASCADE,
  job_id UUID REFERENCES public.jobs (id) ON DELETE CASCADE,

  title TEXT NOT NULL,
  body  TEXT,

  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread
  ON public.notifications (recipient_user_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_tenant_created
  ON public.notifications (tenant_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- Recipients can read and update (mark-read) their own notifications.
CREATE POLICY notifications_recipient_select ON public.notifications
  FOR SELECT TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND recipient_user_id = auth.uid()
  );

CREATE POLICY notifications_recipient_update ON public.notifications
  FOR UPDATE TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND recipient_user_id = auth.uid()
  )
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND recipient_user_id = auth.uid()
  );

-- Owners / admins can read every notification in their tenant so a
-- future dashboard can show "help requests" / "blockers raised today".
CREATE POLICY notifications_owner_admin_all ON public.notifications
  FOR ALL TO authenticated
  USING (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.tenant_id = public.notifications.tenant_id
        AND tm.role IN ('owner','admin')
    )
  )
  WITH CHECK (
    tenant_id = public.current_tenant_id()
    AND EXISTS (
      SELECT 1 FROM public.tenant_members tm
      WHERE tm.user_id = auth.uid()
        AND tm.tenant_id = public.notifications.tenant_id
        AND tm.role IN ('owner','admin')
    )
  );

COMMENT ON TABLE public.notifications IS
  'Generic notifications table used as a stand-in for push infra until Twilio / Expo wiring lands. Phase 3 of the Tasks module writes task_assigned / task_done / task_blocked / task_help / task_verified / task_rejected rows.';
