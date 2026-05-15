/**
 * Format a widget submission into the `intake_drafts.pasted_text` shape.
 *
 * Mirrors the "forwarding context" pattern used by the email intake path
 * (`src/server/actions/inbound-email-intake.ts`). The classifier reads
 * pasted_text as the primary narrative; surrounding metadata sits at the
 * top so the structured fields are obvious to both humans and the model.
 */

export type WidgetBriefInput = {
  name: string;
  phone: string;
  email: string | null;
  description: string;
};

const PASTED_TEXT_CAP = 16000;

export function formatWidgetBriefText(input: WidgetBriefInput): string {
  const lines: string[] = [
    'Submitted via website lead form',
    `Name: ${input.name}`,
    `Phone: ${input.phone}`,
  ];
  if (input.email) lines.push(`Email: ${input.email}`);
  lines.push('', input.description.trim());
  return lines.join('\n').slice(0, PASTED_TEXT_CAP);
}
