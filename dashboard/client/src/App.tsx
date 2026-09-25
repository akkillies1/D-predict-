import { useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import DatabaseSettings from "./components/DatabaseSettings";
import DecisionDashboard from "./components/DecisionDashboard";
import IPOAnalyzer from "./components/IPOAnalyzer";
import OptionChainTradingPanel from "./components/OptionChainTradingPanel";
import ResearchPanel from "./components/ResearchPanel";
import ShadowTradingPanel from "./components/ShadowTradingPanel";
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
                {([["trade", "Trade"], ["decision", "Decision"]] as [View, string][]).map(([key, label]) => (
                  <button key={key} onClick={() => select(key)} className={`rounded-lg px-4 py-1.5 transition-colors ${view === key ? "bg-[#142a25] text-[#c8f169]" : "text-[#789087] hover:text-[#d7e8d9]"}`}>{label}</button>
                ))}
              </nav>
            </div>
          </header>
          {view === "trade" ? (
            <TradingDesk />
          ) : (
            <>
              <DecisionDashboard />
              <Research20Panel />
              <OptionChainTradingPanel />
              <ShadowTradingPanel />
              <ModelCoveragePanel />
              <ResearchPanel />
              <IPOAnalyzer />
              <DatabaseSettings />
            </>
          )}
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
