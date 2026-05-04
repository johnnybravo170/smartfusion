/**
 * Known task identifiers — what each AI call is for.
 *
 * Drives:
 *   - Routing config (AG-3): per-task primary + fallback chain
 *   - Telemetry (AG-5): every ai_calls row carries `task` for cost
 *     attribution and admin dashboard rollups
 *   - Spend pacing (AG-6): tier-climb policy can target specific tasks
 *
 * Adding a task: append below + add a routing entry in AG-3's config.
 * The `task` field on requests is `string` (not the union) so adding
 * a new task doesn't require coordinated type changes — but unrecognized
 * tasks fall through to the default routing policy.
 */

export const KNOWN_TASKS = [
  'receipt_ocr', // worker/owner expense form receipt extraction
  'invoice_payment_ocr', // cheque / e-transfer screenshot OCR for invoice payments
  'project_memo_generate', // project memo drafting from notes + photos
  'email_classify', // inbound email type classification
  'coa_account_suggest', // chart-of-accounts category suggestions
  'inbound_lead_enrich', // intake lead enrichment from raw text
  'sub_quote_parse', // sub-trade quote PDF → structured line items
  'scope_scaffold', // project scope scaffold from intake notes
] as const;

export type KnownTask = (typeof KNOWN_TASKS)[number];
