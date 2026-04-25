/**
 * Document type vocabulary. App-side enum kept in sync with the
 * project_documents.type CHECK constraint.
 */

export const DOCUMENT_TYPES = [
  'contract',
  'permit',
  'warranty',
  'manual',
  'inspection',
  'coi',
  'other',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const documentTypeLabels: Record<DocumentType, string> = {
  contract: 'Contract',
  permit: 'Permit',
  warranty: 'Warranty',
  manual: 'Manual',
  inspection: 'Inspection',
  coi: 'COI',
  other: 'Other',
};

/**
 * Display order on the homeowner portal — manuals + warranties get
 * prominent placement (top of the list); permits + inspections sit in
 * a less-prominent spot since the homeowner needs them rarely.
 */
export const DOCUMENT_TYPE_DISPLAY_ORDER: DocumentType[] = [
  'warranty',
  'manual',
  'contract',
  'inspection',
  'permit',
  'coi',
  'other',
];

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}
