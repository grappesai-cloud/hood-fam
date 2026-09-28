import { Suspense, type ReactNode } from "react";
import { TeamApp } from "@/components/team/app/TeamApp";

export const metadata = { title: "Block 0 · team launch" };

export default function TeamLayout({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <TeamApp>{children}</TeamApp>
    </Suspense>
  );
}
