import { User } from 'lucide-react';
import { notFound } from 'next/navigation';
import { OperatorProfileForm } from '@/components/features/settings/operator-profile-form';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { getOperatorProfile } from '@/lib/db/queries/profile';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Your profile — Settings' };

/**
 * Operator's personal profile — split out of Business profile so the
 * personal-account fields (name, title, default hourly rate) live in
 * their own audience-appropriate page rather than buried under "Business
 * profile" alongside the customer-facing branding.
 */
export default async function YourProfilePage() {
  const [tenant, user] = await Promise.all([getCurrentTenant(), getCurrentUser()]);
  if (!tenant || !user) notFound();

  const operator = await getOperatorProfile(tenant.id, user.id);
  if (!operator) notFound();

  return (
    <>
      <SettingsPageHeader
        title="Your profile"
        description="Your name, title, and default hourly rate. Shown on customer-facing emails and PDFs and used to attribute time + expenses you log."
      />
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <User className="size-5" />
            <div>
              <CardTitle>Your info</CardTitle>
              <CardDescription>
                Your name and title appear on customer-facing emails and PDFs. Your default hourly
                rate prefills when you log time on a project.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <OperatorProfileForm profile={operator} />
        </CardContent>
      </Card>
    </>
  );
}
