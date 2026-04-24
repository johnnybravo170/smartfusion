import { checkWindow, defaultWindow } from '@/lib/ar/policy';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { createClient } from '@/lib/supabase/server';
import { sendSms } from '@/lib/twilio/client';
import type { AiTool } from '../types';

export const smsTools: AiTool[] = [
  {
    definition: {
      name: 'send_sms',
      description:
        "Send an SMS text message. Use for customer-facing messages (reminders, confirmations, review requests) signed off as the operator, or for platform-to-operator notices signed off as Hey Henry. Phone numbers must be in E.164 format (e.g. +16045551234). Honor the operator's tone and keep messages short.",
      input_schema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient phone number in E.164 format (e.g. +16045551234).',
          },
          body: {
            type: 'string',
            description:
              'The full message text. Include the appropriate signoff: "— [Operator Business Name]" for customer-facing, "— Hey Henry" for platform-facing. Keep under 160 chars when possible; longer messages will be segmented.',
          },
          identity: {
            type: 'string',
            enum: ['operator', 'platform'],
            description:
              "Who the message is from. 'operator' = operator → their customer (default). 'platform' = Hey Henry → operator.",
          },
          related_type: {
            type: 'string',
            enum: ['job', 'quote', 'invoice', 'customer', 'support_ticket', 'platform'],
            description: 'Optional: what record this message relates to, for the activity feed.',
          },
          related_id: {
            type: 'string',
            description: 'Optional: UUID of the related record.',
          },
        },
        required: ['to', 'body'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        // Quiet hours check: get tenant timezone and verify we're in the SMS send window
        const supabase = await createClient();
        const { data: tenantRow } = await supabase
          .from('tenants')
          .select('timezone')
          .eq('id', tenant.id)
          .maybeSingle();

        const timezone = tenantRow?.timezone ?? tenant.timezone ?? 'America/Vancouver';
        const now = new Date();
        const windowCheck = checkWindow(now, defaultWindow('sms'), timezone);

        if (!windowCheck.ok) {
          const localTime = now.toLocaleTimeString('en-CA', {
            timeZone: timezone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
          });
          return (
            `It's currently outside SMS hours (${localTime} ${timezone}). ` +
            `Quiet window is 10am–9pm Mon–Fri. Send anyway, or wait until morning?`
          );
        }

        const result = await sendSms({
          tenantId: tenant.id,
          to: String(input.to),
          body: String(input.body),
          identity: input.identity === 'platform' ? 'platform' : 'operator',
          relatedType: input.related_type as
            | 'job'
            | 'quote'
            | 'invoice'
            | 'customer'
            | 'support_ticket'
            | 'platform'
            | undefined,
          relatedId: input.related_id as string | undefined,
        });

        if (!result.ok) {
          return `SMS failed: ${result.error}${result.code ? ` (${result.code})` : ''}`;
        }

        return `SMS sent to ${input.to}. Twilio SID: ${result.sid}.`;
      } catch (e) {
        return `Failed to send SMS: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
