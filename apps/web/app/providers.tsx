"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { useState, type ReactNode } from "react";
import { wagmiConfig } from "@/lib/config";
import { SafeAutoConnect } from "@/components/SafeStrip";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: { queries: { refetchInterval: 8_000, refetchIntervalInBackground: true, staleTime: 4_000 } },
  }));
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <SafeAutoConnect />
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  );
}
