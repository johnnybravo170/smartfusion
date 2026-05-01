/**
 * Public API for the bank-recon CSV parser. Importers (BR-4 upload UI)
 * use only `parseBankStatement` + the types; the inner detection layers
 * are implementation detail.
 */

export type { BankPreset } from '@/lib/db/schema/bank-statements';
export { MAX_BYTES, MAX_ROWS, PREVIEW_ROWS, parseBankStatement } from './parser';
export type {
  ColumnMap,
  DateFormat,
  DetectionSource,
  ParsedStatement,
  ParsedTransaction,
  ParseResult,
  ParserOptions,
  ParseWarning,
  SignConvention,
} from './types';
