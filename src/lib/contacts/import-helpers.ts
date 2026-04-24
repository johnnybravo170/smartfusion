/**
 * Platform helpers for importing contacts from the phone into the intake
 * form:
 *   - Contact Picker API (Chrome Android) — `pickPhoneContact()`.
 *   - vCard (.vcf) file parsing — works everywhere, used on iOS Safari
 *     where the Contact Picker API is not implemented.
 *
 * Both surfaces produce the same shape so the UI wires them up identically.
 *
 * Native iOS/Android integration lives in the Expo app (ops card
 * ff05d6a2). This module is web-only.
 */

export type ImportedContact = {
  name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
};

/**
 * True when the browser exposes the Contact Picker API. Chrome on Android
 * only; Safari / Firefox / desktop all return false.
 *
 * Use this to show the "Import from phone" button only where it works.
 */
export function contactPickerSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return (
    'contacts' in navigator &&
    typeof (navigator as unknown as { contacts?: { select?: unknown } }).contacts?.select ===
      'function'
  );
}

type ContactPickerResult = Array<{
  name?: string[];
  tel?: string[];
  email?: string[];
  address?: Array<{ addressLine?: string[]; city?: string; region?: string; postalCode?: string }>;
}>;

export async function pickPhoneContact(): Promise<ImportedContact | null> {
  if (!contactPickerSupported()) return null;
  try {
    const nav = navigator as unknown as {
      contacts: {
        select: (props: string[], opts?: { multiple?: boolean }) => Promise<ContactPickerResult>;
      };
    };
    const picked = await nav.contacts.select(['name', 'tel', 'email', 'address'], {
      multiple: false,
    });
    if (!picked || picked.length === 0) return null;
    const c = picked[0];
    const name = c.name?.[0] ?? null;
    const phone = c.tel?.[0] ?? null;
    const email = c.email?.[0] ?? null;
    const addr = c.address?.[0];
    const addressParts: string[] = [];
    if (addr?.addressLine?.length) addressParts.push(...addr.addressLine);
    if (addr?.city) addressParts.push(addr.city);
    if (addr?.region) addressParts.push(addr.region);
    if (addr?.postalCode) addressParts.push(addr.postalCode);
    const address = addressParts.length ? addressParts.join(', ') : null;
    return { name, phone, email, address };
  } catch {
    // User denied permission, cancelled the picker, or the browser threw.
    // All cases: return null and let the caller fall back to manual input.
    return null;
  }
}

/** Quick-and-dirty vCard 3.0/4.0 parser. Pulls FN, TEL, EMAIL, ADR. */
export async function parseVCardFile(file: File): Promise<ImportedContact | null> {
  let text: string;
  try {
    text = await file.text();
  } catch {
    return null;
  }
  if (!/BEGIN:VCARD/i.test(text)) return null;

  // vCard spec allows line folding (CRLF + space) — unfold first.
  const unfolded = text.replace(/\r?\n[ \t]/g, '');

  const pick = (tag: string): string | null => {
    const re = new RegExp(`^${tag}(;[^:\\r\\n]*)?:(.+)$`, 'im');
    const m = unfolded.match(re);
    return m?.[2]?.trim() ?? null;
  };

  const name = pick('FN') ?? pick('N')?.replace(/;/g, ' ').trim() ?? null;
  const phone = pick('TEL');
  const email = pick('EMAIL');
  const adrRaw = pick('ADR');
  // ADR fields are semicolon-delimited:
  //   post-office-box;extended-address;street;city;region;postal-code;country
  const addressParts = adrRaw
    ? adrRaw
        .split(';')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];
  const address = addressParts.length ? addressParts.join(', ') : null;

  return { name, phone, email, address };
}

/** True when the file looks like a vCard (by extension or MIME type). */
export function isVCardFile(file: File): boolean {
  if (/\.vcf$/i.test(file.name)) return true;
  if (file.type === 'text/vcard' || file.type === 'text/x-vcard') return true;
  return false;
}

/**
 * Turn an ImportedContact into the same shape the intake form's pastedText
 * field expects (one field per line) so the existing AI prompt can do its
 * normal extraction pass over it.
 */
export function importedContactToPastedText(c: ImportedContact): string {
  const lines: string[] = [];
  if (c.name) lines.push(`Name: ${c.name}`);
  if (c.phone) lines.push(`Phone: ${c.phone}`);
  if (c.email) lines.push(`Email: ${c.email}`);
  if (c.address) lines.push(`Address: ${c.address}`);
  return lines.join('\n');
}
