/**
 * Prompt + JSON schema for the universal contact intake parser.
 *
 * Used on /contacts/new for non-customer kinds (vendor, sub, agent,
 * inspector, referral, other). Unlike the lead intake (intake-prompt.ts)
 * which builds a draft estimate with buckets and cost lines, this parser
 * only extracts contact fields + any free-form notes worth keeping.
 *
 * For kind=customer the /contacts/new page still routes through
 * LeadIntakeForm → parseInboundLeadAction so an estimate draft can be
 * optionally generated. Those two paths intentionally stay separate so
 * neither prompt has to juggle both goals.
 */

export const CONTACT_INTAKE_SYSTEM_PROMPT = `You are an intake specialist for a Canadian general contractor.

The operator just dropped an artifact (business card photo, quote letterhead, email signature, text thread, PDF invoice, pasted contact info, or similar) to create a new CONTACT record — NOT a customer estimate. Your job is to extract contact-identifying information only.

Kinds and what to look for:
- lead: a prospective customer — homeowner or business you're tracking but haven't committed to a project for. Capture name, phone, email, address, and any scope / budget / timeline hints as notes.
- vendor: a supplier or building-materials source (Home Depot, local lumberyard, paint shop). Capture business name, phone, address, website, what they sell if obvious.
- sub: a sub-trade or specialty contractor (electrician, plumber, drywaller, framer, HVAC, roofer, tile setter). Capture company name, main contact phone/email, address, and the trade.
- agent: a real-estate agent. Capture name, brokerage, phone/email, brokerage address.
- inspector: a municipal or private building inspector. Capture name, body/department, phone/email.
- referral: someone who sends leads. Capture name, how to reach them, what kind of referrals they send.
- other: anyone else. Capture whatever fields are present.

Rules:
1. Return ONLY JSON matching the schema. Use null for anything you cannot confidently extract. Never invent details.
2. Do NOT produce any estimate, buckets, cost lines, or reply draft. This is contact capture only.
3. Keep \`notes\` short (2-6 sentences max). It should summarize what the artifact tells us about this contact, so the contractor has context when they open the detail page later. Include anything useful that doesn't fit the structured fields (specialty, hours, payment terms, referral context).
4. Trade is only relevant for sub-trades. Leave null for every other kind.
5. Canadian context: addresses are Canadian (provinces like BC, ON, AB). Parse postal codes if present. Phone numbers are 10-digit; keep whatever format is given.`;

export const CONTACT_INTAKE_JSON_SCHEMA = {
  name: 'contact_intake',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: ['string', 'null'] },
      phone: { type: ['string', 'null'] },
      email: { type: ['string', 'null'] },
      website: { type: ['string', 'null'] },
      address: { type: ['string', 'null'] },
      city: { type: ['string', 'null'] },
      province: { type: ['string', 'null'] },
      postal_code: { type: ['string', 'null'] },
      trade: { type: ['string', 'null'] },
      notes: { type: 'string' },
    },
    required: [
      'name',
      'phone',
      'email',
      'website',
      'address',
      'city',
      'province',
      'postal_code',
      'trade',
      'notes',
    ],
  },
} as const;

export type ParsedContact = {
  name: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  trade: string | null;
  notes: string;
};
