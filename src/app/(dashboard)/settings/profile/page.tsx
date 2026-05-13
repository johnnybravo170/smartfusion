import { Building2, ImageIcon, Link2 } from 'lucide-react';
import { notFound } from 'next/navigation';
import { BusinessProfileForm } from '@/components/features/settings/business-profile-form';
import { LogoUploader } from '@/components/features/settings/logo-uploader';
import { SettingsPageHeader } from '@/components/features/settings/settings-page-header';
import { SocialsForm } from '@/components/features/settings/socials-form';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { getCurrentTenant } from '@/lib/auth/helpers';
import { getBusinessProfile } from '@/lib/db/queries/profile';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Business profile — Settings' };

/**
 * Customer-facing business identity. Operator's personal profile moved to
 * /settings/your-profile and tenant-wide customer-portal settings moved
 * to /settings/customer-portal so each audience-distinct concern is its
 * own sidebar item.
 */
export default async function SettingsProfilePage() {
  const tenant = await getCurrentTenant();
  if (!tenant) notFound();

  const business = await getBusinessProfile(tenant.id);
  if (!business) notFound();

  return (
    <>
      <SettingsPageHeader
        title="Business profile"
        description="What customers see on quotes, invoices, gallery pages, and project emails."
      />
      <div className="space-y-6">
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
      </div>
    </>
  );
}
