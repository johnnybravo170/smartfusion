import { getCurrentTenant } from '@/lib/auth/helpers';
import { invoiceTotalCents } from '@/lib/db/queries/invoices';
import { getJob, listJobs, listWorklogForJob } from '@/lib/db/queries/jobs';
import { createClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/twilio/client';
import { draftPulseAction } from '@/server/actions/pulse';
import {
  formatCad,
  formatDate,
  formatDateTime,
  invoiceStatusLabels,
  jobStatusLabels,
} from '../format';
import { resolveByShortId } from '../helpers/resolve-by-short-id';
import { resolveCustomer } from '../helpers/resolve-customer';
import type { AiTool } from '../types';

export const jobTools: AiTool[] = [
  {
    definition: {
      name: 'list_jobs',
      description:
        'List jobs. Filter by status (booked/in_progress/complete/cancelled), customer, or use filter="uninvoiced" (completed jobs without an invoice) or filter="upcoming" (booked jobs scheduled in the next 7 days).',
      input_schema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['uninvoiced', 'upcoming'],
            description:
              'Preset filter. "uninvoiced" = completed jobs without an invoice. "upcoming" = booked jobs scheduled in the next N days (use days_ahead; default 7).',
          },
          status: {
            type: 'string',
            enum: ['booked', 'in_progress', 'complete', 'cancelled'],
            description: 'Filter by job status (ignored when filter is set)',
          },
          customer_id: {
            type: 'string',
            description: 'Filter by customer UUID (ignored when filter is set)',
          },
          days_ahead: {
            type: 'number',
            description: 'For filter="upcoming": days ahead to look (default 7)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 100)',
          },
        },
      },
    },
    handler: async (input) => {
      try {
        if (input.filter === 'uninvoiced') {
          const tenant = await getCurrentTenant();
          if (!tenant) return 'Not authenticated.';

          const supabase = await createClient();

          const { data: invoicedJobIds, error: invErr } = await supabase
            .from('invoices')
            .select('job_id')
            .not('job_id', 'is', null)
            .is('deleted_at', null);

          if (invErr) {
            return `Failed to check invoices: ${invErr.message}`;
          }

          const invoicedSet = new Set(
            (invoicedJobIds ?? []).map((r) => (r as { job_id: string }).job_id),
          );

          const { data: jobs, error: jobErr } = await supabase
            .from('jobs')
            .select(
              'id, completed_at, notes, customers:customer_id (name), quotes:quote_id (total_cents)',
            )
            .eq('status', 'complete')
            .is('deleted_at', null)
            .order('completed_at', { ascending: false });

          if (jobErr) {
            return `Failed to fetch completed jobs: ${jobErr.message}`;
          }

          const uninvoiced = (jobs ?? []).filter((j) => !invoicedSet.has(j.id));

          if (uninvoiced.length === 0) {
            return 'All completed jobs have been invoiced.';
          }

          let output = `Found ${uninvoiced.length} completed job(s) without an invoice:\n\n`;
          for (let i = 0; i < uninvoiced.length; i++) {
            const j = uninvoiced[i];
            const customerRaw = j.customers;
            const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
            const quoteRaw = j.quotes;
            const quote = Array.isArray(quoteRaw) ? quoteRaw[0] : quoteRaw;
            output += `${i + 1}. ${(customer as { name?: string })?.name ?? 'No customer'}\n`;
            if (j.completed_at) output += `   Completed: ${formatDate(j.completed_at)}\n`;
            if (quote)
              output += `   Quote total: ${formatCad((quote as { total_cents: number }).total_cents)}\n`;
            if (j.notes) output += `   Notes: ${j.notes}\n`;
            output += `   ID: ${j.id.slice(0, 8)}\n\n`;
          }

          return output;
        }

        if (input.filter === 'upcoming') {
          const tenant = await getCurrentTenant();
          if (!tenant) return 'Not authenticated.';

          const daysAhead = (input.days_ahead as number) ?? 7;
          const now = new Date().toISOString();
          const future = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString();

          const supabase = await createClient();
          const { data, error } = await supabase
            .from('jobs')
            .select('id, scheduled_at, notes, customers:customer_id (name)')
            .eq('status', 'booked')
            .gte('scheduled_at', now)
            .lte('scheduled_at', future)
            .is('deleted_at', null)
            .order('scheduled_at', { ascending: true });

          if (error) {
            return `Failed to fetch upcoming jobs: ${error.message}`;
          }

          if (!data || data.length === 0) {
            return `No jobs scheduled in the next ${daysAhead} day(s).`;
          }

          let output = `Upcoming jobs (next ${daysAhead} day(s)):\n\n`;
          for (let i = 0; i < data.length; i++) {
            const j = data[i];
            const customerRaw = j.customers;
            const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
            output += `${i + 1}. ${(customer as { name?: string })?.name ?? 'No customer'}\n`;
            if (j.scheduled_at) output += `   Scheduled: ${formatDateTime(j.scheduled_at)}\n`;
            if (j.notes) output += `   Notes: ${j.notes}\n`;
            output += `   ID: ${j.id.slice(0, 8)}\n\n`;
          }

          return output;
        }

        const rows = await listJobs({
          status: input.status as 'booked' | 'in_progress' | 'complete' | 'cancelled' | undefined,
          customer_id: input.customer_id as string | undefined,
          limit: Math.min((input.limit as number) || 20, 100),
        });

        if (rows.length === 0) {
          return 'No jobs found matching your criteria.';
        }

        let output = `Found ${rows.length} job(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const j = rows[i];
          output += `${i + 1}. ${j.customer?.name ?? 'No customer'}\n`;
          output += `   Status: ${jobStatusLabels[j.status] ?? j.status}`;
          if (j.scheduled_at) output += ` | Scheduled: ${formatDateTime(j.scheduled_at)}`;
          if (j.completed_at) output += ` | Completed: ${formatDate(j.completed_at)}`;
          output += '\n';
          if (j.notes) output += `   Notes: ${j.notes}\n`;
          output += `   ID: ${j.id}\n\n`;
        }

        return output;
      } catch (e) {
        return `Failed to list jobs: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_job',
      description:
        'Get full job details including customer, quote link, invoice link, and recent worklog entries.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job UUID' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      try {
        const job = await getJob(input.id as string);
        if (!job) {
          return 'Job not found.';
        }

        const worklog = await listWorklogForJob(job.id);

        let output = `Job Details\n${'='.repeat(40)}\n\n`;
        output += `Customer: ${job.customer?.name ?? 'N/A'}\n`;
        output += `Status: ${jobStatusLabels[job.status] ?? job.status}\n`;
        if (job.scheduled_at) output += `Scheduled: ${formatDateTime(job.scheduled_at)}\n`;
        if (job.started_at) output += `Started: ${formatDateTime(job.started_at)}\n`;
        if (job.completed_at) output += `Completed: ${formatDateTime(job.completed_at)}\n`;
        if (job.notes) output += `Notes: ${job.notes}\n`;

        if (job.quote) {
          output += `\nLinked Quote: ${job.quote.id}\n`;
          output += `  Quote Total: ${formatCad(job.quote.total_cents)}\n`;
          output += `  Quote Status: ${job.quote.status}\n`;
        }

        if (job.invoices.length > 0) {
          output += `\nLinked Invoice(s)\n${'-'.repeat(20)}\n`;
          for (const inv of job.invoices) {
            output += `  ${inv.id} - ${invoiceStatusLabels[inv.status] ?? inv.status} - ${formatCad(invoiceTotalCents(inv))}\n`;
          }
        }

        if (worklog.length > 0) {
          output += `\nRecent Worklog\n${'-'.repeat(30)}\n`;
          for (const w of worklog.slice(0, 5)) {
            output += `  [${formatDate(w.created_at)}] ${w.title ?? '(no title)'}`;
            if (w.body) output += ` - ${w.body}`;
            output += '\n';
          }
        }

        return output;
      } catch (e) {
        return `Failed to get job: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'update_job_status',
      description:
        "Change a job's status and log the transition to the worklog. Sets started_at/completed_at timestamps automatically.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Job UUID' },
          status: {
            type: 'string',
            enum: ['booked', 'in_progress', 'complete', 'cancelled'],
            description: 'New status',
          },
        },
        required: ['id', 'status'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        const supabase = await createClient();
        const jobId = input.id as string;
        const newStatus = input.status as string;

        // Load current job
        const { data: job, error: loadErr } = await supabase
          .from('jobs')
          .select('id, status, started_at, completed_at, customers:customer_id (name)')
          .eq('id', jobId)
          .is('deleted_at', null)
          .maybeSingle();

        if (loadErr || !job) {
          return 'Job not found.';
        }

        const oldStatus = job.status as string;
        if (oldStatus === newStatus) {
          return `Job is already ${jobStatusLabels[newStatus] ?? newStatus}. No change needed.`;
        }

        // Build update
        const now = new Date().toISOString();
        const updateFields: Record<string, unknown> = {
          status: newStatus,
          updated_at: now,
        };
        if (newStatus === 'in_progress' && !job.started_at) {
          updateFields.started_at = now;
        }
        if (newStatus === 'complete' && !job.completed_at) {
          updateFields.completed_at = now;
        }

        const { error: updateErr } = await supabase
          .from('jobs')
          .update(updateFields)
          .eq('id', jobId);

        if (updateErr) {
          return `Failed to update job: ${updateErr.message}`;
        }

        // Extract customer name from Supabase join
        const customerRaw = job.customers as unknown;
        const customerObj = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
        const customerName =
          customerObj && typeof customerObj === 'object' && 'name' in customerObj
            ? (customerObj as { name: string }).name
            : 'customer';

        // Log to worklog
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Job status changed',
          body: `Job for ${customerName} moved from ${jobStatusLabels[oldStatus] ?? oldStatus} to ${jobStatusLabels[newStatus] ?? newStatus}.`,
          related_type: 'job',
          related_id: jobId,
        });

        return (
          `Job status updated: ${jobStatusLabels[oldStatus] ?? oldStatus} -> ${jobStatusLabels[newStatus] ?? newStatus}\n` +
          `Customer: ${customerName}\nJob ID: ${jobId}`
        );
      } catch (e) {
        return `Failed to update job status: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'create_job',
      description:
        'Create a new job for a customer. Optionally schedule it for a specific date/time and link to an existing quote.',
      input_schema: {
        type: 'object',
        properties: {
          customer_name_or_id: {
            type: 'string',
            description: 'Customer name (fuzzy match) or UUID',
          },
          scheduled_at: {
            type: 'string',
            description: 'ISO date/time for when the job is scheduled (e.g. 2026-04-22T09:00)',
          },
          quote_id: {
            type: 'string',
            description: 'Link to an existing quote UUID or short ID',
          },
          notes: { type: 'string', description: 'Job notes' },
        },
        required: ['customer_name_or_id'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        const resolved = await resolveCustomer(input.customer_name_or_id as string);
        if (typeof resolved === 'string') return resolved;

        // Resolve quote if provided
        let quoteId: string | null = null;
        if (input.quote_id) {
          const quoteResult = await resolveByShortId<{ id: string }>(
            'quotes',
            input.quote_id as string,
            'id',
          );
          if (typeof quoteResult === 'string') return `Quote lookup failed: ${quoteResult}`;
          quoteId = quoteResult.id;
        }

        const scheduledAt = input.scheduled_at ? String(input.scheduled_at) : null;

        const supabase = await createClient();
        const { data: job, error } = await supabase
          .from('jobs')
          .insert({
            tenant_id: tenant.id,
            customer_id: resolved.id,
            quote_id: quoteId,
            status: 'booked',
            scheduled_at: scheduledAt,
            notes: (input.notes as string) ?? null,
          })
          .select('id')
          .single();

        if (error || !job) {
          return `Failed to create job: ${error?.message ?? 'Unknown error'}`;
        }

        // Add worklog entry
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Job booked',
          body: `Job booked for ${resolved.name}${scheduledAt ? ` on ${formatDateTime(scheduledAt)}` : ''}.`,
          related_type: 'job',
          related_id: job.id,
        });

        let response = `Job booked for ${resolved.name}`;
        if (scheduledAt) response += ` on ${formatDateTime(scheduledAt)}`;
        response += `. Status: booked. ID: ${job.id.slice(0, 8)}`;

        return response;
      } catch (e) {
        return `Failed to create job: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'schedule_job',
      description: 'Schedule or reschedule a job for a specific date/time.',
      input_schema: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: 'Job UUID or short ID (first 8 chars)',
          },
          scheduled_at: {
            type: 'string',
            description: 'ISO date/time (e.g. 2026-04-22T09:00)',
          },
        },
        required: ['job_id', 'scheduled_at'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        type JobRow = {
          id: string;
          status: string;
          customers: { name: string } | { name: string }[];
        };

        const result = await resolveByShortId<JobRow>(
          'jobs',
          input.job_id as string,
          'id, status, customers:customer_id (name)',
        );
        if (typeof result === 'string') return result;

        const job = result;
        const scheduledAt = String(input.scheduled_at);
        const now = new Date().toISOString();

        const supabase = await createClient();
        const { error } = await supabase
          .from('jobs')
          .update({ scheduled_at: scheduledAt, updated_at: now })
          .eq('id', job.id);

        if (error) {
          return `Failed to schedule job: ${error.message}`;
        }

        const customerRaw = job.customers;
        const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
        const customerName = customer?.name ?? 'customer';

        // Add worklog entry
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Job rescheduled',
          body: `Job for ${customerName} scheduled to ${formatDateTime(scheduledAt)}.`,
          related_type: 'job',
          related_id: job.id,
        });

        return `Job for ${customerName} rescheduled to ${formatDateTime(scheduledAt)}.`;
      } catch (e) {
        return `Failed to schedule job: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'create_review_request',
      description: 'Send a review request SMS to a customer after job completion',
      input_schema: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: 'Job UUID or short ID',
          },
        },
        required: ['job_id'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        type JobRow = {
          id: string;
          status: string;
          customers:
            | { name: string; phone: string | null }
            | { name: string; phone: string | null }[];
        };

        const result = await resolveByShortId<JobRow>(
          'jobs',
          input.job_id as string,
          'id, status, customers:customer_id (name, phone)',
        );
        if (typeof result === 'string') return result;

        const job = result;

        if (job.status !== 'complete') {
          return `Job is "${jobStatusLabels[job.status] ?? job.status}". Review requests can only be sent for completed jobs.`;
        }

        const customerRaw = job.customers;
        const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;

        if (!customer?.phone) {
          return `Cannot send review request: ${customer?.name ?? 'customer'} has no phone number on file.`;
        }

        const firstName = customer.name.split(' ')[0];
        const body = `Hi ${firstName}, thanks for having us out today! If you have a moment, we'd really appreciate a Google review — it helps us a ton. Just search ${tenant.name} on Google!`;

        const smsResult = await sendSms({
          tenantId: tenant.id,
          to: customer.phone,
          body,
          identity: 'operator',
          relatedType: 'job',
          relatedId: job.id,
          caslCategory: 'transactional',
          caslEvidence: { kind: 'review_request', jobId: job.id },
        });

        if (!smsResult.ok) {
          return `Failed to send review request: ${smsResult.error}`;
        }

        const supabase = await createClient();
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Review request sent',
          body: `Review request sent to ${customer.name} (${customer.phone}).`,
          related_type: 'job',
          related_id: job.id,
        });

        return `Review request sent to ${customer.name} at ${customer.phone}.`;
      } catch (e) {
        return `Failed to send review request: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'draft_pulse_update',
      description:
        'Draft a Project Pulse update for a job (homeowner-facing progress summary). Returns the draft body so the owner can review before approving and sending. Does NOT send anything by itself.',
      input_schema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job UUID' },
        },
        required: ['job_id'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        const result = await draftPulseAction(input.job_id as string);
        if (!result.ok) return `Failed to draft pulse update: ${result.error}`;

        // Pull the draft body so Henry can show it back to the owner.
        const supabase = await createClient();
        const { data } = await supabase
          .from('pulse_updates')
          .select('body_md')
          .eq('id', result.id)
          .maybeSingle();

        const body = (data?.body_md as string | undefined) ?? '(empty draft)';
        return `Drafted pulse update (id ${result.id.slice(0, 8)}). Open the job page and click "Update Client" to review and send.\n\n${body}`;
      } catch (e) {
        return `Failed to draft pulse update: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
