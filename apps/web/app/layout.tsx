import type { Metadata } from "next";
import "./globals.css";
import "./brand.css";
import { Providers } from "./providers";
import { brand } from "@/brands";
import { CANONICAL, SITE } from "@/lib/site";

/// The shell, the words and the mark come from the brand this build was made as (`brands/`), so the
/// same launchpad can be several products without a second copy of anything underneath it.
const TITLE = brand.name;
const DESCRIPTION = brand.description;

/// `metadataBase` is what turns a relative image into an absolute one in a share card, and without
/// it every unfurl on X and Telegram is text only. Each token page overrides this with its own
/// card in `app/token/[address]/layout.tsx`.
export const metadata: Metadata = {
  metadataBase: new URL(SITE),
  title: { default: TITLE, template: "%s" },
  description: DESCRIPTION,
  applicationName: TITLE,
  openGraph: { title: TITLE, description: DESCRIPTION, url: SITE, siteName: TITLE, type: "website" },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
  // A preview of this site runs on another host before launch. robots.txt asks a crawler to stay
  // away from it; this says the same thing on the page itself, for the crawler that arrives from
  // a pasted link rather than from the root.
  robots: CANONICAL ? { index: true, follow: true } : { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-brand={brand.id}>
      <body className="min-h-screen">
        <Providers>
          <brand.Shell>{children}</brand.Shell>
        </Providers>
      </body>
    </html>
  );
}
