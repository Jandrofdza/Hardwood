import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hardwood",
  description: "Everything about your buildings.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">
        <header className="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
          <div className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-4">
            <Link href="/" className="text-lg font-semibold tracking-wide">
              Hard<span className="text-wood-600">wood</span>
            </Link>
            <nav className="text-sm text-stone-500">
              <Link href="/" className="hover:text-stone-900 dark:hover:text-white">
                Buildings
              </Link>
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-8">{children}</main>
        <footer className="mx-auto max-w-5xl px-4 pb-8 text-xs text-stone-500">
          Demo data: these buildings and their facts are fictional.
        </footer>
      </body>
    </html>
  );
}
