import { notFound } from 'next/navigation';
import { DeleteAccountCard } from '@/components/features/settings/delete-account-card';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { getCurrentTenant } from '@/lib/auth/helpers';

export const metadata = { title: 'Delete account — Settings' };

export default async function DeleteAccountSettingsPage() {
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();

  // Anyone can land on this page, but only the owner can submit the form.
  // We pass the role down so non-owners see a "ask your owner" message.
  return (
    <>
      <SettingsPageHeader
        title="Delete account"
        description="Permanently remove this workspace and everything in it. There's a 30-day reversibility window before anything is hard-deleted."
      />
      <DeleteAccountCard businessName={tenant.name} isOwner={tenant.member.role === 'owner'} />
    </>
  );
}
