import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { branding } from './lib/branding';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://astroid.club';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${branding.brandName} · Coming soon`,
    template: `%s · ${branding.brandName}`,
  },
  description:
    'Astroid Club is the community home for $ASTROID holders. A place to gather, share, and be early. Coming soon.',
  keywords: [
    'Astroid',
    'Astroid Club',
    '$ASTROID',
    'Solana',
    'community',
    'holders',
    'coming soon',
  ],
  authors: [{ name: 'Astroid' }],
  openGraph: {
    title: 'Astroid Club - Coming soon',
    description:
      'The community home for $ASTROID holders. Doors open soon.',
    type: 'website',
    url: SITE_URL,
    siteName: 'Astroid Club',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Astroid Club - Coming soon',
    description:
      'The community home for $ASTROID holders. Doors open soon.',
    site: '@Astroid_Sol',
    creator: '@Astroid_Sol',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased min-h-screen flex flex-col">
        {children}
      </body>
    </html>
  );
}
