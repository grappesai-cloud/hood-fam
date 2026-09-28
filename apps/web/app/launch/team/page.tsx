"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { isAddress, type Address } from "viem";
import { TeamWatch } from "@/components/TeamWatch";
import { LaunchWizard } from "@/components/team/app/LaunchWizard";

/// Block zero: a curve launch where every team wallet buys in the launch transaction itself.
///
/// The launch and the buys are one transaction through HoodBlockZero, so nothing can trade between
/// them, and the periphery writes every wallet, what it paid, what it got and its lock on chain. The
/// token page reads that back and labels the team on the holder map. `?draft=` opens the launch
/// desk on a draft; `?token=` opens the watch of a launch that went through.

export default function TeamLaunchPage() {
  return (
    <Suspense fallback={null}>
      <TeamLaunch />
    </Suspense>
  );
}

function TeamLaunch() {
  const params = useSearchParams();
  const watching = params.get("token");
  if (watching && isAddress(watching)) {
    return <div className="tapp-page"><TeamWatch token={watching.toLowerCase() as Address} /></div>;
  }
  return <LaunchWizard draftId={params.get("draft")} />;
}
