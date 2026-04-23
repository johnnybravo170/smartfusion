'use client';

/**
 * Owner-only toggle that forces every member of the tenant to enroll in
 * MFA. Flipping it on starts a 14-day grace clock for each unenrolled
 * member; after that, sensitive actions soft-lock until they enroll.
 */

import { Loader2, Users } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { setRequireMfaForAllMembersAction } from '@/server/actions/tenant-security';

export function RequireMfaToggle({ initialValue }: { initialValue: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState(initialValue);
  const [pending, startTransition] = useTransition();

  function handleChange(next: boolean) {
    const previous = value;
    setValue(next);
    startTransition(async () => {
      const result = await setRequireMfaForAllMembersAction({ value: next });
      if (!result.ok) {
        setValue(previous);
        toast.error(result.error);
        return;
      }
      toast.success(
        next
          ? 'Two-factor authentication is now required for all team members.'
          : 'Two-factor authentication is now optional for team members.',
      );
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Users className="size-5 text-muted-foreground" />
          <div>
            <CardTitle>Require 2FA for all team members</CardTitle>
            <CardDescription>
              When on, every team member must enroll within 14 days. Owners are always required
              regardless of this setting.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-2">
          <Checkbox
            id="require-mfa-all"
            checked={value}
            onCheckedChange={(v) => handleChange(v === true)}
            disabled={pending}
          />
          <Label htmlFor="require-mfa-all" className="font-normal">
            Require 2FA for all team members
          </Label>
          {pending ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
        </div>
      </CardContent>
    </Card>
  );
}
