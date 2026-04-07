import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'ReflexRush',
  description: 'Wie schnell bist du wirklich? Kompetitives Reaktionsspiel.',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  );
}
