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
  type MouseEventParams,
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
  linesStorageKey?: string;
};

type Tooltip = { x: number; y: number; bar: ChartBar } | null;
type DrawPoint = { time: number; price: number };
type DrawLine = { id: string; kind: "h"; price: number } | { id: string; kind: "trend"; from: DrawPoint; to: DrawPoint };
type DrawTool = "off" | "h" | "trend";

const BULL = "#c8f169";
const BEAR = "#ff9d91";
const DRAW_COLOR = "#e5b55f";
const toTime = (timestamp: string) => Math.floor(Date.parse(timestamp) / 1000) as UTCTimestamp;
const fmt = (value: number) => value.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const uid = () => Math.random().toString(36).slice(2, 10);
const segmentDistance = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};

export default function PriceChart({ bars, bands, minuteScale, livePrice, liveActive, overlays, linesStorageKey }: Props) {
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
  const [tool, setTool] = useState<DrawTool>("off");
  const [draft, setDraft] = useState<DrawPoint | null>(null);
  const [lines, setLines] = useState<DrawLine[]>([]);
  const toolRef = useRef<DrawTool>("off");
  const draftRef = useRef<DrawPoint | null>(null);
  const linesRef = useRef<DrawLine[]>([]);
  const drawnHandlesRef = useRef<{ priceLines: IPriceLine[]; trendSeries: ISeriesApi<"Line">[] }>({ priceLines: [], trendSeries: [] });
  const selectTool = (next: DrawTool) => {
    const value = toolRef.current === next ? "off" : next;
    toolRef.current = value;
    draftRef.current = null;
    setDraft(null);
    setTool(value);
  };
  const clearLines = () => {
    draftRef.current = null;
    setDraft(null);
    setLines([]);
  };

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
    // The chart instance is brand new; any handles left in the ref belong to a
    // previous instance (HMR remount) and must not be removed from this chart.
    drawnHandlesRef.current = { priceLines: [], trendSeries: [] };
    // Own the sizing explicitly so the chart is correct even when it mounts
    // while throttled (background tab); autoSize's ResizeObserver + rAF render
    // loop are paused when the page is hidden, leaving the buffer unsized.
    const ro = new ResizeObserver(entries => {
      const box = entries[0]?.contentRect;
      if (box && box.width > 0 && box.height > 0) chart.resize(box.width, box.height);
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

    // Drawing layer: active-tool clicks place price levels (one click) or
    // trend lines (two clicks); right-click deletes the nearest drawn line.
    const onClick = (param: MouseEventParams) => {
      const activeTool = toolRef.current;
      const candles = candleRef.current;
      if (activeTool === "off" || !param.point || !candles) return;
      const price = candles.coordinateToPrice(param.point.y);
      if (price == null) return;
      if (activeTool === "h") {
        setLines(prev => [...prev, { id: uid(), kind: "h", price }]);
        return;
      }
      const time = chart.timeScale().coordinateToTime(param.point.x);
      if (time == null) return;
      const point = { time: Number(time), price };
      if (!draftRef.current) {
        draftRef.current = point;
        setDraft(point);
      } else {
        const first = draftRef.current;
        draftRef.current = null;
        setDraft(null);
        const [from, to] = first.time <= point.time ? [first, point] : [point, first];
        setLines(prev => [...prev, { id: uid(), kind: "trend", from, to }]);
      }
    };
    chart.subscribeClick(onClick);
    const onContextMenu = (event: MouseEvent) => {
      const candles = candleRef.current;
      if (!candles || !linesRef.current.length) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      let nearest: { id: string; distance: number } | null = null;
      for (const line of linesRef.current) {
        let distance = Number.POSITIVE_INFINITY;
        if (line.kind === "h") {
          const py = candles.priceToCoordinate(line.price);
          if (py != null) distance = Math.abs(py - y);
        } else {
          const x1 = chart.timeScale().timeToCoordinate(line.from.time as UTCTimestamp);
          const x2 = chart.timeScale().timeToCoordinate(line.to.time as UTCTimestamp);
          const y1 = candles.priceToCoordinate(line.from.price);
          const y2 = candles.priceToCoordinate(line.to.price);
          if (x1 != null && x2 != null && y1 != null && y2 != null) distance = segmentDistance(x, y, x1, y1, x2, y2);
        }
        if (distance < 12 && (!nearest || distance < nearest.distance)) nearest = { id: line.id, distance };
      }
      if (nearest) setLines(prev => prev.filter(line => line.id !== nearest!.id));
    };
    el.addEventListener("contextmenu", onContextMenu);
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      draftRef.current = null;
      setDraft(null);
      toolRef.current = "off";
      setTool("off");
    };
    window.addEventListener("keydown", onKey);

    return () => {
      window.removeEventListener("keydown", onKey);
      el.removeEventListener("contextmenu", onContextMenu);
      resizeRef.current?.disconnect();
      resizeRef.current = null;
      chart.remove();
      drawnHandlesRef.current = { priceLines: [], trendSeries: [] };
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

  // Paint user-drawn lines: price levels become price lines on the candle
  // series; trend lines get their own two-point series (rebuilt on change).
  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleRef.current;
    if (!chart || !candles) return;
    const handles = drawnHandlesRef.current;
    for (const priceLine of handles.priceLines) candles.removePriceLine(priceLine);
    for (const series of handles.trendSeries) chart.removeSeries(series);
    handles.priceLines = [];
    handles.trendSeries = [];
    for (const line of lines) {
      if (line.kind === "h") {
        handles.priceLines.push(candles.createPriceLine({
          price: line.price, color: DRAW_COLOR, lineWidth: 1, lineStyle: LineStyle.Solid,
          axisLabelVisible: true, title: "level",
        }));
      } else {
        const series = chart.addSeries(LineSeries, {
          color: DRAW_COLOR, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        series.setData([
          { time: line.from.time as UTCTimestamp, value: line.from.price },
          { time: line.to.time as UTCTimestamp, value: line.to.price },
        ]);
        handles.trendSeries.push(series);
      }
    }
  }, [lines]);

  useEffect(() => {
    draftRef.current = null;
    setDraft(null);
    toolRef.current = "off";
    setTool("off");
    if (!linesStorageKey) { setLines([]); return; }
    try {
      const parsed = JSON.parse(localStorage.getItem(linesStorageKey) ?? "[]");
      setLines(Array.isArray(parsed) ? parsed.filter(line =>
        (line?.kind === "h" && Number.isFinite(line.price)) ||
        (line?.kind === "trend" && [line.from?.time, line.from?.price, line.to?.time, line.to?.price].every(Number.isFinite))
      ) : []);
    } catch { setLines([]); }
  }, [linesStorageKey]);

  useEffect(() => {
    linesRef.current = lines;
    if (!linesStorageKey) return;
    try { localStorage.setItem(linesStorageKey, JSON.stringify(lines)); } catch { /* storage full or blocked */ }
  }, [lines, linesStorageKey]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="absolute inset-0" style={{ cursor: tool === "off" ? "default" : "crosshair" }} />
      <div className="absolute right-14 top-1 z-10 flex items-center gap-1">
        {tool !== "off" ? (
          <span className="mr-1 rounded-md border border-[#1d332f] bg-[#0a1512]/90 px-2 py-1 font-mono-ui text-[9px] text-[#c8b582]">
            {tool === "h" ? "click to place a level · right-click deletes · Esc stops" : draft ? "click to set the end point · Esc cancels" : "click to set the start point · Esc stops"}
          </span>
        ) : null}
        <button
          type="button"
          aria-pressed={tool === "h"}
          onClick={() => selectTool("h")}
          title="Draw horizontal price level: pick the tool, then click the chart. Right-click a line to delete it."
          className={`rounded-md border px-2 py-1 font-mono-ui text-[10px] transition-colors ${tool === "h" ? "border-[#4e4226] bg-[#211d12] text-[#e5b55f]" : "border-[#1d332f] bg-[#0a1512]/90 text-[#789087] hover:text-[#d7e8d9]"}`}
        >
          — Level
        </button>
        <button
          type="button"
          aria-pressed={tool === "trend"}
          onClick={() => selectTool("trend")}
          title="Draw trend line: pick the tool, then click a start and an end point. Right-click a line to delete it."
          className={`rounded-md border px-2 py-1 font-mono-ui text-[10px] transition-colors ${tool === "trend" ? "border-[#4e4226] bg-[#211d12] text-[#e5b55f]" : "border-[#1d332f] bg-[#0a1512]/90 text-[#789087] hover:text-[#d7e8d9]"}`}
        >
          ╱ Trend
        </button>
        <button
          type="button"
          onClick={clearLines}
          disabled={!lines.length}
          title={`Delete all ${lines.length} drawn lines`}
          className="rounded-md border border-[#1d332f] bg-[#0a1512]/90 px-2 py-1 font-mono-ui text-[10px] text-[#789087] transition-colors hover:text-[#ff9d91] disabled:cursor-default disabled:opacity-40 disabled:hover:text-[#789087]"
        >
          ✕ {lines.length || ""}
        </button>
      </div>
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
