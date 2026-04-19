import { ArContactTable } from '@/components/features/admin/ar/contact-table';
import { listArContacts } from '@/lib/db/queries/ar-admin';

export const dynamic = 'force-dynamic';

export default async function AdminArContactsPage() {
  const contacts = await listArContacts(200);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Contacts</h1>
        <p className="text-sm text-muted-foreground">
          {contacts.length} {contacts.length === 1 ? 'contact' : 'contacts'} on the Hey Henry
          marketing list.
        </p>
      </div>
      <ArContactTable contacts={contacts} />
    </div>
  );
}
