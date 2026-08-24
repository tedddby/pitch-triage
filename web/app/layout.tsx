import type { ReactNode } from "react";

export const metadata = {
  title: "Pitch Triage",
  description: "Human-reviewed triage for inbound PR pitch replies",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
          background: "#0f1115",
          color: "#e7e9ee",
        }}
      >
        {children}
      </body>
    </html>
  );
}
