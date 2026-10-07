import { useState } from "react";
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

type View = "trade" | "decision";

function App() {
  const [view, setView] = useState<View>(() => (localStorage.getItem("dpredict:view") as View) || "decision");
  const select = (next: View) => { setView(next); localStorage.setItem("dpredict:view", next); };
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <header className="sticky top-0 z-30 border-b border-[#1d332f] bg-[#08120f]/95 backdrop-blur">
            <div className="mx-auto flex w-full max-w-[1600px] items-center justify-between px-4 py-2.5 lg:px-8">
              <div className="font-display text-sm font-semibold tracking-wide text-[#c8f169]">D‑PREDICT</div>
              <nav className="flex gap-1 text-xs font-semibold">
                {([["trade", "Paper Lab"], ["decision", "Decision"]] as [View, string][]).map(([key, label]) => (
                  <button key={key} onClick={() => select(key)} className={`rounded-lg px-4 py-1.5 transition-colors ${view === key ? "bg-[#142a25] text-[#c8f169]" : "text-[#789087] hover:text-[#d7e8d9]"}`}>{label}</button>
                ))}
              </nav>
            </div>
          </header>
          <UpdateBanner />
          {view === "trade" ? (
            <section aria-label="Paper Lab" id="paper-lab">
              <div className="mx-auto max-w-[1540px] px-4 pb-3 sm:px-6 lg:px-8">
                <div className="rounded-xl border border-[#29483d] bg-[#0c1b17] px-4 py-3">
                  <div className="font-mono-ui text-[9px] uppercase tracking-[.18em] text-[#c8f169]">Paper Lab</div>
                  <p className="mt-1 text-xs text-[#8da59a]">Simulation and research only. No broker orders are sent.</p>
                </div>
              </div>
              <TradingDesk />
            </section>
          ) : (
            <div className="space-y-10">
              <section id="decision-lifecycle" aria-labelledby="decision-section-title">
                <div className="mx-auto max-w-[1540px] px-4 pb-3 sm:px-6 lg:px-8">
                  <div className="flex items-end justify-between gap-4">
                    <div>
                      <div className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#789087]">01 / Decision</div>
                      <h2 id="decision-section-title" className="mt-1 font-display text-xl font-semibold text-[#edf5e9]">Authoritative decision</h2>
                      <p className="mt-1 text-xs text-[#70887d]">The backend candidate is the only source of paper eligibility.</p>
                    </div>
                  </div>
                </div>
                <DecisionDashboard />
              </section>

              <section id="evidence" aria-labelledby="evidence-section-title">
                <div className="mx-auto max-w-[1540px] px-4 pb-3 sm:px-6 lg:px-8">
                  <div className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#789087]">02 / Evidence</div>
                  <h2 id="evidence-section-title" className="mt-1 font-display text-xl font-semibold text-[#edf5e9]">Evidence & market context</h2>
                  <p className="mt-1 text-xs text-[#70887d]">Signals, options, research and market context explain the decision; they do not override it.</p>
                </div>
                <Research20Panel />
                <OptionChainTradingPanel />
                <ResearchPanel />
                <IPOAnalyzer />
              </section>

              <section id="validation" aria-labelledby="validation-section-title">
                <div className="mx-auto max-w-[1540px] px-4 pb-3 sm:px-6 lg:px-8">
                  <div className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#789087]">03 / Validation</div>
                  <h2 id="validation-section-title" className="mt-1 font-display text-xl font-semibold text-[#edf5e9]">Validation & model readiness</h2>
                  <p className="mt-1 text-xs text-[#70887d]">Coverage and realized performance validate the system; neither creates a trade recommendation.</p>
                </div>
                <ModelCoveragePanel />
              </section>

              <section id="paper-lab-section" aria-labelledby="paper-section-title">
                <div className="mx-auto max-w-[1540px] px-4 pb-3 sm:px-6 lg:px-8">
                  <div className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#789087]">04 / Paper Lab</div>
                  <h2 id="paper-section-title" className="mt-1 font-display text-xl font-semibold text-[#edf5e9]">Paper execution & shadow state</h2>
                  <p className="mt-1 text-xs text-[#70887d]">All orders, positions and P&L are simulated. No broker execution exists.</p>
                </div>
                <ShadowTradingPanel />
              </section>

              <section id="ai" aria-labelledby="ai-section-title">
                <div className="mx-auto max-w-[1540px] px-4 pb-3 sm:px-6 lg:px-8">
                  <div className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#789087]">05 / AI</div>
                  <h2 id="ai-section-title" className="mt-1 font-display text-xl font-semibold text-[#edf5e9]">AI explanation & controls</h2>
                  <p className="mt-1 text-xs text-[#70887d]">AI can explain backend evidence, but cannot override decision gates.</p>
                </div>
                <AiAssistant />
              </section>

              <section id="system" aria-labelledby="system-section-title">
                <div className="mx-auto max-w-[1540px] px-4 pb-3 sm:px-6 lg:px-8">
                  <div className="font-mono-ui text-[9px] uppercase tracking-[.2em] text-[#789087]">06 / System</div>
                  <h2 id="system-section-title" className="mt-1 font-display text-xl font-semibold text-[#edf5e9]">System configuration</h2>
                  <p className="mt-1 text-xs text-[#70887d]">Database and model configuration affect readiness; they never manufacture evidence.</p>
                </div>
                <DatabaseSettings />
                <AiSettings />
              </section>
            </div>
          )}
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
