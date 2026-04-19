import type { ReactNode } from 'react';
import { ArNav } from '@/components/features/admin/ar/ar-nav';

export default function AdminArLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <ArNav />
      {children}
    </div>
  );
}
