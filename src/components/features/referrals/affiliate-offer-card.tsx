import { DollarSign, Handshake } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AffiliateTier } from '@/server/actions/referrals';

export function AffiliateOfferCard({ tier }: { tier: AffiliateTier }) {
  if (tier === 'tier_1' || tier === 'tier_2') {
    return (
      <Card className="border-emerald-200 bg-emerald-50/50">
        <CardHeader className="flex flex-row items-start gap-3 space-y-0">
          <Handshake className="mt-0.5 h-5 w-5 text-emerald-700" />
          <div>
            <CardTitle className="text-lg">Custom partner agreement</CardTitle>
            <CardDescription>
              You&apos;re on a partner program with terms outside the standard offer below.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>
            Commission terms are in your signed agreement. Reach out to Jonathan with any questions.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-emerald-200 bg-emerald-50/50">
      <CardHeader className="flex flex-row items-start gap-3 space-y-0">
        <DollarSign className="mt-0.5 h-5 w-5 text-emerald-700" />
        <div>
          <CardTitle className="text-lg">Earn $300 for every contractor you refer</CardTitle>
          <CardDescription>
            Refer a contractor who becomes a paying customer and earn $300, paid after their first
            30 days.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">
        <ul className="space-y-1.5">
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-700">&#10003;</span>
            <span>Flat $300 bounty per converted paying customer.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-700">&#10003;</span>
            <span>Paid out 30 days after the customer&apos;s first paid month.</span>
          </li>
          <li className="flex items-start gap-2">
            <span className="mt-0.5 text-emerald-700">&#10003;</span>
            <span>No cap. Refer as many contractors as you like.</span>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}
