import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import DecisionDashboard from "./components/DecisionDashboard";
import IPOAnalyzer from "./components/IPOAnalyzer";
import ResearchPanel from "./components/ResearchPanel";
import { ThemeProvider } from "./contexts/ThemeContext";

function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><Toaster/><DecisionDashboard/><ResearchPanel/><IPOAnalyzer/></TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;
