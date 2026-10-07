import { useEffect, useState } from "react";
import { Activity, BrainCircuit, ChartNoAxesCombined, FlaskConical, Gauge, Layers3, Settings2, ShieldCheck } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import AiAssistant from "./components/AiAssistant";
import AiSettings from "./components/AiSettings";
import DatabaseSettings from "./components/DatabaseSettings";
import DecisionDashboard from "./components/DecisionDashboard";
import IPOAnalyzer from "./components/IPOAnalyzer";
import OptionChainTradingPanel from "./components/OptionChainTradingPanel";
import ResearchPanel from "./components/ResearchPanel";
import ShadowTradingPanel from "./components/ShadowTradingPanel";
import UpdateBanner from "./components/UpdateBanner";
import Research20Panel from "./components/Research20Panel";
import ModelCoveragePanel from "./components/ModelCoveragePanel";
import TradingDesk from "./components/TradingDesk";
import { ThemeProvider } from "./contexts/ThemeContext";

type View = "decision" | "evidence" | "validation" | "paper" | "ai" | "system";

const tabs: Array<{ key: View; label: string; icon: typeof Gauge; eyebrow: string }> = [
  { key: "decision", label: "Decision", icon: Gauge, eyebrow: "01" },
  { key: "evidence", label: "Evidence", icon: ChartNoAxesCombined, eyebrow: "02" },
  { key: "validation", label: "Validation", icon: FlaskConical, eyebrow: "03" },
  { key: "paper", label: "Paper Lab", icon: ShieldCheck, eyebrow: "04" },
  { key: "ai", label: "AI", icon: BrainCircuit, eyebrow: "05" },
  { key: "system", label: "System", icon: Settings2, eyebrow: "06" },
];

function readInitialView(): View {
  const hash = window.location.hash.replace(/^#/, "") as View;
  if (tabs.some(tab => tab.key === hash)) return hash;
  const stored = localStorage.getItem("dpredict:view") as View | null;
  return tabs.some(tab => tab.key === stored) ? stored! : "decision";
}

function App() {
  const [view, setView] = useState<View>(readInitialView);

  const select = (next: View) => {
    setView(next);
    localStorage.setItem("dpredict:view", next);
    window.history.replaceState(null, "", `#${next}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace(/^#/, "") as View;
      if (tabs.some(tab => tab.key === hash)) setView(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const active = tabs.find(tab => tab.key === view) ?? tabs[0];

  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <header className="sticky top-0 z-30 border-b border-[#1d332f] bg-[#08120f]/95 backdrop-blur-xl">
            <div className="mx-auto max-w-[1600px] px-3 sm:px-5 lg:px-8">
              <div className="flex min-h-[58px] items-center justify-between gap-4">
                <button type="button" onClick={() => select("decision")} className="flex shrink-0 items-center gap-3 text-left">
                  <span className="grid size-8 place-items-center rounded-lg border border-[#355447] bg-[#0d211b] text-[#c8f169]">
                    <Activity className="size-4" />
                  </span>
                  <span>
                    <span className="block font-display text-sm font-bold tracking-[.12em] text-[#c8f169]">D‑PREDICT</span>
                    <span className="hidden text-[9px] uppercase tracking-[.18em] text-[#668077] sm:block">Decision intelligence terminal</span>
                  </span>
                </button>

                <nav aria-label="Primary" className="flex min-w-0 flex-1 justify-end gap-1 overflow-x-auto py-1">
                  {tabs.map(tab => {
                    const Icon = tab.icon;
                    const selected = view === tab.key;
                    return (
                      <button key={tab.key} type="button" aria-current={selected ? "page" : undefined} onClick={() => select(tab.key)}
                        className={`group flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-[11px] font-semibold transition-all sm:px-3 ${selected ? "bg-[#142a25] text-[#c8f169] shadow-[inset_0_0_0_1px_rgba(200,241,105,.14)]" : "text-[#718980] hover:bg-[#0e1d19] hover:text-[#d7e8d9]"}`}>
                        <Icon className="size-3.5" /><span>{tab.label}</span>
                      </button>
                    );
                  })}
                </nav>
              </div>
            </div>
          </header>

          <UpdateBanner />

          <main className="min-h-[calc(100vh-58px)]">
            <div className="mx-auto max-w-[1540px] px-4 pt-5 sm:px-6 lg:px-8">
              <div className="mb-5 flex items-end justify-between gap-4">
                <div>
                  <div className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#789087]">{active.eyebrow} / {active.label}</div>
                  <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-[#edf5e9]">{active.label}</h1>
                  <p className="mt-1 max-w-3xl text-xs text-[#70887d]">
                    {view === "decision" && "The backend decision candidate is authoritative; forecast, evidence and execution remain separate layers."}
                    {view === "evidence" && "Market context and research explain what the system sees without becoming an execution authority."}
                    {view === "validation" && "Model coverage and realized performance show whether the research stack is ready for promotion."}
                    {view === "paper" && "Virtual execution only. Orders, positions and P&L are simulated and never reach a broker."}
                    {view === "ai" && "Bounded local AI can explain D‑Predict evidence but cannot override deterministic gates."}
                    {view === "system" && "Runtime, database and model configuration. Missing state is surfaced instead of hidden."}
                  </p>
                </div>
                <div className="hidden items-center gap-2 rounded-full border border-[#29483d] bg-[#0c1b17] px-3 py-1.5 text-[10px] text-[#8da59a] md:flex">
                  <Layers3 className="size-3.5 text-[#c8f169]" /> LOCAL · PAPER ONLY
                </div>
              </div>
            </div>

            {view === "decision" && <DecisionDashboard />}

            {view === "evidence" && (
              <section aria-label="Evidence" className="space-y-10">
                <Research20Panel /><OptionChainTradingPanel /><ResearchPanel /><IPOAnalyzer />
              </section>
            )}

            {view === "validation" && <section aria-label="Validation"><ModelCoveragePanel /></section>}

            {view === "paper" && (
              <section aria-label="Paper Lab" className="space-y-10 pb-12">
                <div className="mx-auto max-w-[1540px] px-4 sm:px-6 lg:px-8">
                  <div className="rounded-xl border border-[#29483d] bg-[#0c1b17] px-4 py-3">
                    <div className="font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#c8f169]">Research execution boundary</div>
                    <p className="mt-1 text-xs text-[#8da59a]">Paper simulation only. No broker connection or exchange order submission exists.</p>
                  </div>
                </div>
                <ShadowTradingPanel /><TradingDesk />
              </section>
            )}

            {view === "ai" && <section aria-label="AI" className="space-y-8"><AiAssistant /></section>}

            {view === "system" && (
              <section aria-label="System" className="space-y-8 pb-12">
                <DatabaseSettings /><AiSettings />
              </section>
            )}
          </main>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
