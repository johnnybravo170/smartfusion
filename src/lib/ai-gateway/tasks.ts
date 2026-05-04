/**
 * Known task identifiers — what each AI call is for.
 *
 * Drives:
 *   - Routing config: per-task primary + fallback chain
 *   - Telemetry: every ai_calls row carries `task` for cost
 *     attribution and admin dashboard rollups
 *   - Spend pacing: tier-climb policy can target specific tasks
 *
 * Adding a task: append below + add a routing entry in routing.ts.
 * The `task` field on requests is `string` (not the union) so adding
 * a new task doesn't require coordinated type changes — but unrecognized
 * tasks fall through to the default routing policy.
 */

export const KNOWN_TASKS = [
  'receipt_ocr', // worker/owner expense form receipt extraction
  'invoice_payment_ocr', // cheque / e-transfer screenshot OCR for invoice payments
  'project_memo_transcribe', // stage 1: audio → transcript only
  'project_memo_extract', // stage 2: transcript + photos → structured work items
  'project_memo_extract_thinking', // stage 2 second pass with extended thinking
  'email_classify', // inbound email type classification
  'coa_account_suggest', // chart-of-accounts category suggestions
  'inbound_lead_enrich', // intake lead enrichment from raw text
  'sub_quote_parse', // sub-trade quote PDF → structured line items
  'scope_scaffold', // project scope scaffold from intake notes
  'pulse_progress_draft', // homeowner-friendly job progress summary
  'document_type_classify', // single-word document type classification
  'decision_suggest', // 0–3 homeowner decisions from job state
  'photo_classify_internal', // job-site photo classification (internal docs)
  'photo_label_homeowner', // homeowner-portal photo caption + labels
  'overhead_expense_extract', // overhead-mode receipt extraction (OpenAI legacy)
  'contact_parse_intake', // intake artifact → structured contact
  'intake_augment_suggest', // suggest project amendments from intake notes
  'note_reply_draft', // Henry Q&A reply draft on project notes
  'audio_transcribe_intake', // Whisper transcription of intake voice memo
  'intake_full_parse', // Anthropic tool-use intake → estimate + tasks
  'intake_artifact_classify', // Gemini Flash batch classification of intake artifacts (per-artifact chip row)
  'intake_scope_augment', // post-parse "what's likely missing from this scope?" pass
] as const;

export type KnownTask = (typeof KNOWN_TASKS)[number];
