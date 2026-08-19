import type { ReactNode } from 'react';
import { AppShell } from '@/components/AppShell';

export default function MemberLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
