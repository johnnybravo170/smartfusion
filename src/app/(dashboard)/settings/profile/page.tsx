import { Building2, ImageIcon, Link2, User } from 'lucide-react';
import { notFound } from 'next/navigation';
import { BusinessProfileForm } from '@/components/features/settings/business-profile-form';
import { LogoUploader } from '@/components/features/settings/logo-uploader';
import { OperatorProfileForm } from '@/components/features/settings/operator-profile-form';
import { SocialsForm } from '@/components/features/settings/socials-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentTenant, getCurrentUser } from '@/lib/auth/helpers';
import { getBusinessProfile, getOperatorProfile } from '@/lib/db/queries/profile';

export const dynamic = 'force-dynamic';

export default async function SettingsProfilePage() {
  const [tenant, user] = await Promise.all([getCurrentTenant(), getCurrentUser()]);
  if (!tenant || !user) notFound();

  const [business, operator] = await Promise.all([
    getBusinessProfile(tenant.id),
    getOperatorProfile(tenant.id, user.id),
  ]);

  if (!business) notFound();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        <p className="text-sm text-muted-foreground">
          Information that shows on customer-facing emails, galleries, quotes, and invoices.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <ImageIcon className="size-5" />
            <div>
              <CardTitle>Logo</CardTitle>
              <CardDescription>Appears on closeout emails and gallery headers.</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <LogoUploader currentLogoUrl={business.logoSignedUrl} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Building2 className="size-5" />
            <div>
              <CardTitle>Business</CardTitle>
              <CardDescription>
                Used on invoices, quotes, and customer communications.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <BusinessProfileForm profile={business} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Link2 className="size-5" />
            <div>
              <CardTitle>Links & socials</CardTitle>
              <CardDescription>
                Shown in the footer of gallery pages. Socials auto-link to your public profiles.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <SocialsForm socials={business.socials} />
        </CardContent>
      </Card>

      {operator ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <User className="size-5" />
              <div>
                <CardTitle>Your info</CardTitle>
                <CardDescription>
                  Your name and title. Shown on customer-facing emails and PDFs, and used on in-app
                  activity (expenses, time, notes) so your team knows who logged what.
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <OperatorProfileForm profile={operator} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
