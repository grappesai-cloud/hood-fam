"use client";

import { useEffect, useRef } from "react";
import { createChart, ColorType, type IChartApi } from "lightweight-charts";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

interface Candle { t: string; open: string; high: string; low: string; close: string; volume: string }

/// Price comes out of our own trade table, so the chart and the tape can never disagree.
/// It is drawn as market cap rather than price per token: a token priced at 0.0000000053 ETH is a
/// chart of zeroes, and the number everybody actually quotes each other is the cap.
export function Chart({ token, decimals, totalSupply }: { token: string; decimals: number; totalSupply: bigint }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ReturnType<IChartApi["addCandlestickSeries"]> | null>(null);

  const { data } = useQuery({
    queryKey: ["candles", token],
    queryFn: () => api<{ candles: Candle[] }>(`/tokens/${token}/candles?interval=5 minutes`),
    refetchInterval: 10_000,
  });

  useEffect(() => {
    if (!box.current || chart.current) return;
    chart.current = createChart(box.current, {
      layout: { background: { type: ColorType.Solid, color: "#1d1d1d" }, textColor: "#949494", fontSize: 11 },
      grid: { vertLines: { color: "#292929" }, horzLines: { color: "#292929" } },
      rightPriceScale: { borderColor: "#333333" },
      timeScale: { borderColor: "#333333", timeVisible: true },
      height: 320,
      autoSize: true,
    });
    series.current = chart.current.addCandlestickSeries({
      upColor: "#ccff00", downColor: "#ff6b70", borderVisible: false,
      wickUpColor: "#ccff00", wickDownColor: "#ff6b70",
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    });
    return () => { chart.current?.remove(); chart.current = null; };
  }, []);

  useEffect(() => {
    if (!series.current || !data) return;
    // price is pair wei per 1e18 token wei, so cap = price * supply / 1e18, then out of wei
    const supply = Number(totalSupply) / 1e18;
    const scale = 10 ** decimals / supply;
    series.current.setData(
      data.candles.map((c) => ({
        time: Math.floor(new Date(c.t).getTime() / 1000) as never,
        open: Number(c.open) / scale,
        high: Number(c.high) / scale,
        low: Number(c.low) / scale,
        close: Number(c.close) / scale,
      })),
    );
  }, [data, decimals, totalSupply]);

  return (
    <div className="panel chart-panel p-2">
      <div className="chart-heading"><span>LIVE MARKET</span><strong>Market cap</strong><small>5 MIN CANDLES</small></div>
      <div ref={box} />
      {data?.candles.length === 0 && (
        <p className="p-6 text-center text-sm dim">No trades yet. The first buy draws the first candle.</p>
      )}
    </div>
  );
}
