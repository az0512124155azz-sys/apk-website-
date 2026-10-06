import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'APK Studio',
  description: 'Inspect, edit, rebuild and reconstruct Android APKs',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" dir="ltr">
      <body>{children}</body>
    </html>
  );
}
