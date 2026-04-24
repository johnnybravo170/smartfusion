'use client';

import Link from 'next/link';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useTenantTimezone } from '@/lib/auth/tenant-context';
import { formatDate } from '@/lib/date/format';
import type { CustomerRow } from '@/lib/db/queries/customers';
import type { CustomerType } from '@/lib/validators/customer';
import { CustomerTypeBadge } from './customer-type-badge';

function contactLine(customer: CustomerRow): string {
  if (customer.email) return customer.email;
  if (customer.phone) return customer.phone;
  return '—';
}

function locationLine(customer: CustomerRow): string {
  if (customer.city && customer.province) return `${customer.city}, ${customer.province}`;
  if (customer.city) return customer.city;
  if (customer.province) return customer.province;
  return '—';
}

/**
 * Server-rendered customer table. Rows link to the detail page. The hover
 * effect is the standard shadcn `TableRow` behaviour; we add cursor styling
 * so the row-as-link affordance is obvious.
 */
export function CustomerTable({ customers }: { customers: CustomerRow[] }) {
  const timezone = useTenantTimezone();
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[100px]">Type</TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Location</TableHead>
            <TableHead className="w-[140px]">Added</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {customers.map((customer) => (
            <TableRow
              key={customer.id}
              className="cursor-pointer transition-colors hover:bg-muted/50"
            >
              <TableCell>
                <CustomerTypeBadge type={customer.type as CustomerType} kind={customer.kind} />
              </TableCell>
              <TableCell className="font-medium">
                <Link href={`/contacts/${customer.id}`} className="text-foreground hover:underline">
                  {customer.name}
                </Link>
              </TableCell>
              <TableCell className="text-muted-foreground">{contactLine(customer)}</TableCell>
              <TableCell className="text-muted-foreground">{locationLine(customer)}</TableCell>
              <TableCell className="text-muted-foreground">
                {formatDate(customer.created_at, { timezone })}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
