import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import ErrorBoundary from "./components/ErrorBoundary";
import IPOAnalyzer from "./components/IPOAnalyzer";
import ResearchPanel from "./components/ResearchPanel";
import { ThemeProvider } from "./contexts/ThemeContext";
import Terminal from "./pages/Terminal";

function App() {
  return <ErrorBoundary><ThemeProvider defaultTheme="dark"><TooltipProvider><Toaster/><Terminal/><ResearchPanel/><IPOAnalyzer/></TooltipProvider></ThemeProvider></ErrorBoundary>;
}

export default App;
