import type { Metadata } from "next";
import "./globals.css";
import AppProviders from "./providers/AppProviders";

export const metadata: Metadata = {
  title: "Vomia — your money runs itself, and stays yours",
  description:
    "An always-on savings & FX agent on Celo. Set one rule; Vomia trades inside your own on-chain vault, within caps only you control. Non-custodial, provable, gas in stablecoins.",
  // Domain-ownership verification (TalentApp). Renders as a <meta> tag in
  // <head> on every route, including the homepage the verifier fetches.
  other: {
    "talentapp:project_verification":
      "4a2da7700d5eaa0201d6e82a4fa2b589b40465c5403c8b22a7e023a5054245b2e175c53fda83c437e5aa63461cf19748557386c76a2120cdb2f58f97d7f3d39d",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Unbounded:wght@400;600;800&family=Space+Grotesk:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
