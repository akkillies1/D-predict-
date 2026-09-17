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
import { ThemeProvider } from "./contexts/ThemeContext";

function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><Toaster/><DecisionDashboard/><Research20Panel/><OptionChainTradingPanel/><ShadowTradingPanel/><ResearchPanel/><IPOAnalyzer/><DatabaseSettings/></TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;
