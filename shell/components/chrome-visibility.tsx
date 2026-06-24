'use client';

/**
 * Hides chrome (e.g. the global footer) on the immersive arena route, where a
 * tall page footer just gets in the way — especially on mobile. Kept as a tiny
 * client wrapper so the rest of the layout stays a server component.
 */

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

export function HideOnArena({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  if (pathname?.startsWith('/arena')) return null;
  return <>{children}</>;
}
