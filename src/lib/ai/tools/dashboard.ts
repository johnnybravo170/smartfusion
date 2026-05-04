import {
  getAttentionItems,
  getKeyMetrics,
  getRecentActivity,
  getTodaysJobs,
} from '@/lib/db/queries/dashboard';
import { formatCad, formatDate } from '../format';
import type { AiTool } from '../types';

/** Timezone is injected at tool-creation time from the tenant. */
let _timezone = 'America/Vancouver';
export function setDashboardTimezone(tz: string) {
  _timezone = tz;
}

export const dashboardTools: AiTool[] = [
  {
    definition: {
      name: 'get_dashboard',
      description:
        "Today's business snapshot: today's jobs, key metrics (revenue, outstanding, open jobs, pending quotes), items needing attention, and recent activity.",
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    handler: async () => {
      try {
        const [todaysJobs, metrics, attention, activity] = await Promise.all([
          getTodaysJobs(_timezone),
          getKeyMetrics(_timezone),
          getAttentionItems(_timezone),
          getRecentActivity(),
        ]);

        let output = `Dashboard Snapshot\n${'='.repeat(40)}\n\n`;

        // Key metrics
        output += `Revenue this month: ${formatCad(metrics.revenueThisMonthCents)}\n`;
        output += `Outstanding (unpaid): ${formatCad(metrics.outstandingCents)}\n`;
        output += `Open jobs: ${metrics.openJobsCount}\n`;
        output += `Pending quotes: ${metrics.pendingQuotesCount}\n`;

        // Today's jobs
        if (todaysJobs.length > 0) {
          output += `\nToday's Jobs\n${'-'.repeat(30)}\n`;
          for (const job of todaysJobs) {
            const time = job.scheduled_at
              ? new Date(job.scheduled_at).toLocaleTimeString('en-CA', {
                  hour: 'numeric',
                  minute: '2-digit',
                  timeZone: _timezone,
                })
              : 'Unscheduled';
            const name = job.customer?.name ?? 'Unknown';
            const city = job.customer?.city ? ` (${job.customer.city})` : '';
            output += `  ${time} - ${name}${city} [${job.status}]\n`;
          }
        } else {
          output += `\nNo jobs scheduled for today.\n`;
        }

        // Attention items
        if (attention.length > 0) {
          output += `\nNeeds Attention\n${'-'.repeat(30)}\n`;
          for (const item of attention) {
            if (item.kind === 'overdue_todo') {
              output += `  Overdue todo: "${item.title}" (${item.daysOverdue} day(s) overdue)\n`;
            } else if (item.kind === 'stale_quote') {
              output += `  Stale quote: ${item.customerName} (sent ${item.daysSinceSent} day(s) ago, no response)\n`;
            } else if (item.kind === 'overdue_invoice') {
              output += `  Overdue invoice: ${item.customerName} - ${formatCad(item.totalCents)} (sent ${item.daysSinceSent} day(s) ago)\n`;
            }
          }
        }

        // Recent activity
        if (activity.length > 0) {
          output += `\nRecent Activity\n${'-'.repeat(30)}\n`;
          for (const entry of activity.slice(0, 5)) {
            output += `  [${formatDate(entry.created_at)}] ${entry.title ?? '(no title)'} (${entry.entry_type})\n`;
          }
        }

        return output;
      } catch (e) {
        return `Dashboard query failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
