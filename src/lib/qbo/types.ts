/**
 * QuickBooks Online entity shapes.
 *
 * Hand-typed from the Intuit Accounting API spec
 * (https://developer.intuit.com/app/developer/qbapi/docs/api/accounting).
 * Only fields the import worker actually reads — the rest passes through
 * as raw QBO objects in `qbo_sync_log.response_body` for auditing.
 *
 * Convention: optional everywhere except `Id` and `SyncToken` (always
 * present on persisted QBO objects). This mirrors how Intuit returns
 * partial responses — a Customer with no email comes back without the
 * `PrimaryEmailAddr` key at all.
 */

export type QboRef = {
  /** QBO Id of the referenced entity. */
  value: string;
  /** Display name of the referenced entity (Intuit sends this for convenience). */
  name?: string;
};

export type QboAddress = {
  Id?: string;
  Line1?: string;
  Line2?: string;
  City?: string;
  /** Province / state abbreviation (BC, ON, AB, ...). */
  CountrySubDivisionCode?: string;
  PostalCode?: string;
  Country?: string;
  Lat?: string;
  Long?: string;
};

export type QboEmail = {
  Address?: string;
};

export type QboPhone = {
  FreeFormNumber?: string;
};

export type QboMetadata = {
  CreateTime?: string;
  LastUpdatedTime?: string;
};

// =====================================================================
// Customer
// =====================================================================

export type QboCustomer = {
  Id: string;
  SyncToken: string;
  Active?: boolean;
  /** Always present. The "name" the bookkeeper sees in QBO. */
  DisplayName: string;
  /** Optional — separate from DisplayName; we surface this on commercial accounts. */
  CompanyName?: string;
  Title?: string;
  GivenName?: string;
  MiddleName?: string;
  FamilyName?: string;
  /** True when this is a sub-customer (job) rather than a real customer. */
  Job?: boolean;
  /** Parent customer when Job=true. */
  ParentRef?: QboRef;
  /** "Customer Type" classification — typically things like Residential/Commercial. */
  CustomerTypeRef?: QboRef;
  PrimaryEmailAddr?: QboEmail;
  PrimaryPhone?: QboPhone;
  Mobile?: QboPhone;
  Fax?: QboPhone;
  BillAddr?: QboAddress;
  ShipAddr?: QboAddress;
  Notes?: string;
  Taxable?: boolean;
  /** Vendors and customers share the schema in QBO except Vendor is a different endpoint. */
  Balance?: number;
  MetaData?: QboMetadata;
};

// =====================================================================
// Vendor (separate QBO entity even though we land both into `customers`)
// =====================================================================

export type QboVendor = {
  Id: string;
  SyncToken: string;
  Active?: boolean;
  DisplayName: string;
  CompanyName?: string;
  GivenName?: string;
  FamilyName?: string;
  PrimaryEmailAddr?: QboEmail;
  PrimaryPhone?: QboPhone;
  Mobile?: QboPhone;
  BillAddr?: QboAddress;
  TaxIdentifier?: string;
  Vendor1099?: boolean;
  Balance?: number;
  MetaData?: QboMetadata;
};

// =====================================================================
// Item (lands in catalog_items)
// =====================================================================

export type QboItem = {
  Id: string;
  SyncToken: string;
  Active?: boolean;
  Name: string;
  /** Inventory | Service | NonInventory | Group | Category */
  Type?: 'Inventory' | 'Service' | 'NonInventory' | 'Group' | 'Category';
  Sku?: string;
  Description?: string;
  /** Unit price for the item. May be 0 for catch-all items. */
  UnitPrice?: number;
  Taxable?: boolean;
  IncomeAccountRef?: QboRef;
  ExpenseAccountRef?: QboRef;
  MetaData?: QboMetadata;
};

// =====================================================================
// Invoice (lands in invoices + line items denormalized for now)
// =====================================================================

export type QboInvoiceLine = {
  Id?: string;
  LineNum?: number;
  Description?: string;
  Amount?: number;
  /** Sub-section of QBO line shape we read. */
  SalesItemLineDetail?: {
    ItemRef?: QboRef;
    UnitPrice?: number;
    Qty?: number;
    TaxCodeRef?: QboRef;
  };
  /** "SubTotalLineDetail" or "GroupLineDetail" lines come through as control rows. */
  DetailType?: string;
};

export type QboInvoice = {
  Id: string;
  SyncToken: string;
  /** Short doc number the customer sees ("INV-1042"). */
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  CustomerRef: QboRef;
  Line?: QboInvoiceLine[];
  /** Tax breakdown — pre-aggregated by QBO. */
  TxnTaxDetail?: {
    TotalTax?: number;
    TxnTaxCodeRef?: QboRef;
  };
  TotalAmt?: number;
  Balance?: number;
  CurrencyRef?: QboRef;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
  EmailStatus?: string;
  /** True when QBO has voided the invoice. */
  Void?: boolean;
  MetaData?: QboMetadata;
};

// =====================================================================
// Payment (linked to invoice via Line[].LinkedTxn)
// =====================================================================

export type QboPaymentLine = {
  Amount?: number;
  LinkedTxn?: Array<{
    TxnId: string;
    TxnType: 'Invoice' | string;
  }>;
};

export type QboPayment = {
  Id: string;
  SyncToken: string;
  TxnDate?: string;
  CustomerRef: QboRef;
  TotalAmt?: number;
  UnappliedAmt?: number;
  PaymentMethodRef?: QboRef;
  PaymentRefNum?: string;
  PrivateNote?: string;
  Line?: QboPaymentLine[];
  MetaData?: QboMetadata;
};

// =====================================================================
// Estimate (lands in quotes)
// =====================================================================

export type QboEstimate = {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TxnDate?: string;
  ExpirationDate?: string;
  CustomerRef: QboRef;
  Line?: QboInvoiceLine[];
  TxnStatus?: 'Accepted' | 'Closed' | 'Pending' | 'Rejected';
  TotalAmt?: number;
  PrivateNote?: string;
  CustomerMemo?: { value?: string };
  MetaData?: QboMetadata;
};

// =====================================================================
// Bill (lands in bills)
// =====================================================================

export type QboBillLine = {
  Id?: string;
  Description?: string;
  Amount?: number;
  DetailType?: 'AccountBasedExpenseLineDetail' | 'ItemBasedExpenseLineDetail';
  AccountBasedExpenseLineDetail?: {
    AccountRef?: QboRef;
    TaxCodeRef?: QboRef;
    ClassRef?: QboRef;
    CustomerRef?: QboRef;
  };
  ItemBasedExpenseLineDetail?: {
    ItemRef?: QboRef;
    Qty?: number;
    UnitPrice?: number;
    TaxCodeRef?: QboRef;
    ClassRef?: QboRef;
    CustomerRef?: QboRef;
  };
};

export type QboBill = {
  Id: string;
  SyncToken: string;
  DocNumber?: string;
  TxnDate?: string;
  DueDate?: string;
  VendorRef: QboRef;
  Line?: QboBillLine[];
  TxnTaxDetail?: { TotalTax?: number };
  TotalAmt?: number;
  Balance?: number;
  PrivateNote?: string;
  MetaData?: QboMetadata;
};

// =====================================================================
// Purchase (one-off expense, no Bill — lands in expenses)
// =====================================================================

export type QboPurchase = {
  Id: string;
  SyncToken: string;
  /** Cash | Check | CreditCard */
  PaymentType?: 'Cash' | 'Check' | 'CreditCard';
  TxnDate?: string;
  /** AccountRef = the source account (bank/credit-card). */
  AccountRef?: QboRef;
  EntityRef?: QboRef;
  Line?: QboBillLine[]; // same line shape as Bill
  TotalAmt?: number;
  PrivateNote?: string;
  DocNumber?: string;
  MetaData?: QboMetadata;
};
