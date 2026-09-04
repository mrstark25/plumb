import type { Metadata, Viewport } from 'next';
import { Providers } from './providers';
import '@/styles/global.css';

export const metadata: Metadata = {
  title: 'Plumb — find true, on-chain',
  description:
    'An execution terminal that prices, explains, and builds swaps, bridges and yield positions in plain English. Your wallet signs; Plumb never holds your keys.',
};

export const viewport: Viewport = {
  themeColor: '#070910',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
