import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";

export type ChartBar = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  time: string;
  sma20: number;
  ema12: number;
  ema26: number;
};
export type ChartBand = { day: number; p10: number; median: number; p90: number };
export type ChartOverlays = { sma20: boolean; ema12: boolean; ema26: boolean; volume: boolean; cone: boolean };

type Props = {
  bars: ChartBar[];
  bands: ChartBand[];
  minuteScale: boolean;
  livePrice: number | null;
  liveActive: boolean;
  overlays: ChartOverlays;
};

type Tooltip = { x: number; y: number; bar: ChartBar } | null;

const BULL = "#c8f169";
const BEAR = "#ff9d91";
const toTime = (timestamp: string) => Math.floor(Date.parse(timestamp) / 1000) as UTCTimestamp;
const fmt = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });

export default function PriceChart({ bars, bands, minuteScale, livePrice, liveActive, overlays }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lineRefs = useRef<Partial<Record<"sma20" | "ema12" | "ema26", ISeriesApi<"Line">>>>({});
  const coneRefs = useRef<ISeriesApi<"Line">[]>([]);
  const liveLineRef = useRef<IPriceLine | null>(null);
  const resizeRef = useRef<ResizeObserver | null>(null);
  const metaRef = useRef<Map<number, ChartBar>>(new Map());
  const appliedRef = useRef<{ first: string; length: number } | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: false,
      width: el.clientWidth || 600,
      height: el.clientHeight || 360,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#789087",
        fontSize: 10,
        fontFamily: "ui-monospace, 'Cascadia Mono', Menlo, monospace",
      },
      grid: { vertLines: { color: "#15271f" }, horzLines: { color: "#15271f" } },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#345346", labelBackgroundColor: "#1d332f" },
        horzLine: { color: "#345346", labelBackgroundColor: "#1d332f" },
      },
      rightPriceScale: { borderColor: "#1d332f", scaleMargins: { top: 0.06, bottom: 0.26 } },
      timeScale: { borderColor: "#1d332f", rightOffset: 2, timeVisible: minuteScale, secondsVisible: false },
      localization: { locale: "en-IN" },
    });
    chartRef.current = chart;
    // Own the sizing explicitly so the chart is correct even when it mounts
    // while throttled (background tab); autoSize's ResizeObserver + rAF render
    // loop are paused when the page is hidden, leaving the buffer unsized.
    const ro = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0 && box.height > 0) chart.resize(box.height, box.width);
    });
    ro.observe(el);
    resizeRef.current = ro;

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: BULL, downColor: BEAR, wickUpColor: BULL, wickDownColor: BEAR,
      borderVisible: false, priceLineVisible: false, lastValueVisible: true,
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
    });
    volumeRef.current = chart.addSeries(HistogramSeries, {
      priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false,
    });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });

    const lineOptions = (color: string, style: LineStyle) => ({
      color, lineWidth: 1 as const, lineStyle: style,
      priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    lineRefs.current = {
      sma20: chart.addSeries(LineSeries, lineOptions("#e5b55f", LineStyle.Dashed)),
      ema12: chart.addSeries(LineSeries, lineOptions("#76b9ff", LineStyle.Solid)),
      ema26: chart.addSeries(LineSeries, lineOptions("#d19cff", LineStyle.Solid)),
    };
    coneRefs.current = [
      chart.addSeries(LineSeries, lineOptions(BULL, LineStyle.Dashed)),
      chart.addSeries(LineSeries, lineOptions(BULL, LineStyle.Solid)),
      chart.addSeries(LineSeries, lineOptions(BULL, LineStyle.Dashed)),
    ];

    chart.subscribeCrosshairMove(param => {
      if (!param.time || !param.point) { setTooltip(null); return; }
      const bar = metaRef.current.get(Number(param.time));
      const candle = param.seriesData.get(candleRef.current!) as CandlestickData | undefined;
      if (!bar || !candle) { setTooltip(null); return; }
      setTooltip({ x: param.point.x, y: param.point.y, bar });
    });

    return () => {
      resizeRef.current?.disconnect();
      resizeRef.current = null;
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      lineRefs.current = {};
      coneRefs.current = [];
      liveLineRef.current = null;
      appliedRef.current = null;
      metaRef.current = new Map();
    };
    // Chart is created once; per-frame options are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    const volume = volumeRef.current;
    if (!chart || !candles || !volume || !bars.length) return;
    chart.timeScale().applyOptions({ timeVisible: minuteScale });

    const last = bars[bars.length - 1];
    const applied = appliedRef.current;
    // Persisted bars are immutable; only the forming bar moves (WS overlay) or a
    // new bar appends. Anything else (symbol/timeframe switch, backfill) is a
    // full setData. Incremental updates preserve the user's scroll/zoom.
    const incremental = applied != null && applied.first === bars[0].timestamp
      && (bars.length === applied.length || bars.length === applied.length + 1);

    const candleAt = (bar: ChartBar): CandlestickData => ({ time: toTime(bar.timestamp), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    const volumeAt = (bar: ChartBar): HistogramData => ({ time: toTime(bar.timestamp), value: bar.volume ?? 0, color: bar.close >= bar.open ? "rgba(200,241,105,.26)" : "rgba(255,157,145,.26)" });
    const lineAt = (bar: ChartBar, key: "sma20" | "ema12" | "ema26"): LineData => ({ time: toTime(bar.timestamp), value: bar[key] });

    metaRef.current = new Map(bars.map(bar => [Number(toTime(bar.timestamp)), bar]));

    if (incremental) {
      candles.update(candleAt(last));
      volume.update(volumeAt(last));
      for (const key of ["sma20", "ema12", "ema26"] as const) lineRefs.current[key]?.update(lineAt(last, key));
    } else {
      candles.setData(bars.map(candleAt));
      volume.setData(bars.map(volumeAt));
      for (const key of ["sma20", "ema12", "ema26"] as const) lineRefs.current[key]?.setData(bars.map(bar => lineAt(bar, key)));
    }
    appliedRef.current = { first: bars[0].timestamp, length: bars.length };

    // Baseline cone: three dashed/solid lines fanning from the last close into
    // the next N trading days (weekends skipped — bands are trading-day based).
    // The quantiles come from the statistical baseline endpoint, not a model.
    const lastTime = Number(toTime(last.timestamp));
    const coneTime = (day: number): number => {
      let t = lastTime;
      let added = 0;
      while (added < day) {
        t += 86400;
        const weekday = new Date(t * 1000).getUTCDay();
        if (weekday !== 0 && weekday !== 6) added += 1;
      }
      return t;
    };
    const coneLine = (key: "p10" | "median" | "p90"): LineData[] => [
      { time: lastTime as UTCTimestamp, value: last.close },
      ...bands.map(band => ({ time: coneTime(band.day) as UTCTimestamp, value: band[key] })),
    ];
    if (bands.length) {
      coneRefs.current[0]?.setData(coneLine("p10"));
      coneRefs.current[1]?.setData(coneLine("median"));
      coneRefs.current[2]?.setData(coneLine("p90"));
    } else {
      for (const series of coneRefs.current) series.setData([]);
    }
  }, [bars, bands, minuteScale]);

  useEffect(() => {
    lineRefs.current.sma20?.applyOptions({ visible: overlays.sma20 });
    lineRefs.current.ema12?.applyOptions({ visible: overlays.ema12 });
    lineRefs.current.ema26?.applyOptions({ visible: overlays.ema26 });
    volumeRef.current?.applyOptions({ visible: overlays.volume });
    const coneVisible = overlays.cone && bands.length > 0;
    for (const series of coneRefs.current) series.applyOptions({ visible: coneVisible });
  }, [overlays, bands.length]);

  useEffect(() => {
    const candles = candleRef.current;
    if (!candles) return;
    if (liveLineRef.current) { candles.removePriceLine(liveLineRef.current); liveLineRef.current = null; }
    if (liveActive && livePrice != null) {
      liveLineRef.current = candles.createPriceLine({
        price: livePrice, color: BULL, lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: "LIVE",
      });
    }
  }, [liveActive, livePrice]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" />
      {tooltip ? (
        <div
          className="pointer-events-none absolute z-10 min-w-[150px] rounded-lg border border-[#1d332f] bg-[#0a1512]/95 px-2.5 py-1.5 font-mono-ui text-[10px] leading-relaxed shadow-[0_10px_30px_rgba(0,0,0,.4)]"
          style={{
            left: Math.min(tooltip.x + 16, Math.max(0, (containerRef.current?.clientWidth ?? 320) - 170)),
            top: Math.max(6, Math.min(tooltip.y - 40, (containerRef.current?.clientHeight ?? 200) - 90)),
          }}
        >
          <div className="text-[#789087]">{tooltip.bar.time}</div>
          <div className="text-[#d7e8d9]">
            O {fmt(tooltip.bar.open)} · H {fmt(tooltip.bar.high)} · L {fmt(tooltip.bar.low)} ·{" "}
            <span className={tooltip.bar.close >= tooltip.bar.open ? "text-[#c8f169]" : "text-[#ff9d91]"}>C {fmt(tooltip.bar.close)}</span>
          </div>
          <div className="text-[#789087]">V {tooltip.bar.volume != null ? tooltip.bar.volume.toLocaleString("en-IN") : "—"} · SMA20 {fmt(tooltip.bar.sma20)}</div>
        </div>
      ) : null}
    </div>
  );
}
