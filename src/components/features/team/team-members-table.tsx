'use client';

/**
 * Table showing all team members with role badges and remove buttons.
 */

import { Fragment } from 'react';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import type { TeamMemberRow } from '@/lib/db/queries/team';
import { RemoveMemberButton } from './remove-member-button';
import { WorkerSettingsRow } from './worker-settings-row';

const roleBadgeVariant: Record<string, 'default' | 'secondary' | 'outline'> = {
  owner: 'default',
  admin: 'secondary',
  member: 'outline',
  worker: 'outline',
};

type Props = {
  members: TeamMemberRow[];
};

export function TeamMembersTable({ members }: Props) {
  const tz = useTenantTimezone();
  if (members.length === 0) {
    return <p className="text-sm text-muted-foreground">No team members found.</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Email</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Joined</TableHead>
          <TableHead className="w-[60px]" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {members.map((member) => (
          <Fragment key={member.id}>
            <TableRow>
              <TableCell className="text-sm">
                {member.worker_profile?.display_name ?? member.email}
                {member.worker_profile?.display_name ? (
                  <div className="text-xs text-muted-foreground">{member.email}</div>
                ) : null}
              </TableCell>
              <TableCell>
                <Badge variant={roleBadgeVariant[member.role] ?? 'outline'}>
                  {member.role === 'worker' && member.worker_profile
                    ? member.worker_profile.worker_type
                    : member.role}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {new Intl.DateTimeFormat(undefined, { timeZone: tz }).format(
                  new Date(member.created_at),
                )}
              </TableCell>
              <TableCell>
                <RemoveMemberButton
                  memberId={member.id}
                  memberEmail={member.email}
                  isOwner={member.role === 'owner'}
                />
              </TableCell>
            </TableRow>
            {member.role === 'worker' && member.worker_profile ? (
              <TableRow>
                <TableCell colSpan={4} className="bg-muted/20 py-3">
                  <WorkerSettingsRow profile={member.worker_profile} />
                </TableCell>
              </TableRow>
            ) : null}
          </Fragment>
        ))}
      </TableBody>
    </Table>
  );
}
