import { URL } from "node:url";

const YAHOO_SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc";
const HEADERS = { "User-Agent": "D-predict/1.0 public-research" };

export type ResearchArticle = {
  title: string;
  url: string;
  source: string;
  publishedAt: string | null;
  language?: string;
  domain?: string;
  sourceType: "news" | "market" | "official";
  score: number;
  stance: "BULLISH" | "BEARISH" | "NEUTRAL";
};

export type ResearchResult = {
  symbol: string;
  companyName: string | null;
  asOf: string;
  direction: "BULLISH" | "BEARISH" | "MIXED";
  confidence: number;
  evidenceScore: number;
  agreement: number;
  articles: ResearchArticle[];
  themes: string[];
  risks: string[];
  publicDisclosureLinks: { label: string; url: string }[];
  disclaimer: string;
};

const POSITIVE = [
  "beat", "beats", "strong", "growth", "surge", "rises", "rise", "rally", "profit", "upgrade",
  "order win", "orders", "deal", "partnership", "record", "buyback", "dividend", "approval", "launch",
  "expansion", "guidance raised", "outperform", "positive", "robust", "improves", "improved"
];

const NEGATIVE = [
  "miss", "misses", "weak", "decline", "falls", "fall", "drop", "drops", "loss", "downgrade", "fraud",
  "probe", "investigation", "default", "debt", "warning", "guidance cut", "resignation", "delay", "penalty",
  "ban", "order cancellation", "negative", "lawsuit", "slump", "cuts"
];

const TOPIC_TERMS: [string, string][] = [
  ["earnings", "Earnings"], ["guidance", "Guidance"], ["order", "Orders / contracts"], ["dividend", "Dividend / capital return"],
  ["buyback", "Buyback"], ["merger", "M&A / restructuring"], ["acquisition", "M&A / restructuring"], ["regulator", "Regulatory"],
  ["sebi", "SEBI / compliance"], ["fraud", "Fraud / governance"], ["investigation", "Investigation"], ["promoter", "Promoter activity"],
  ["insider", "Insider disclosure"], ["board", "Board / management"], ["capacity", "Capacity / capex"], ["expansion", "Expansion / capex"]
];

function scoreText(text: string) {
  const normalized = text.toLowerCase();
  const positiveHits = POSITIVE.filter(term => normalized.includes(term)).length;
  const negativeHits = NEGATIVE.filter(term => normalized.includes(term)).length;
  return Math.max(-1, Math.min(1, (positiveHits - negativeHits) / 4));
}

function stance(score: number): ResearchArticle["stance"] {
  if (score >= 0.25) return "BULLISH";
  if (score <= -0.25) return "BEARISH";
  return "NEUTRAL";
}

async function fetchJson(url: string, timeoutMs = 6000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`upstream ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

function safeDomain(url: string) {
  try { return new URL(url).hostname; } catch { return ""; }
}

async function yahooResearch(symbol: string) {
  try {
    const payload = await fetchJson(`${YAHOO_SEARCH}?q=${encodeURIComponent(symbol)}&quotesCount=5&newsCount=15`);
    const quote = Array.isArray(payload?.quotes) ? payload.quotes.find((item: any) => item?.symbol === symbol || String(item?.symbol ?? "").startsWith(symbol)) : null;
    const companyName = quote?.longname ?? quote?.shortname ?? null;
    const items = Array.isArray(payload?.news) ? payload.news : [];
    const articles: ResearchArticle[] = items.slice(0, 15).map((item: any) => {
      const title = String(item?.title ?? "").trim();
      const score = scoreText(title);
      return { title, url: String(item?.link ?? ""), source: String(item?.publisher ?? safeDomain(String(item?.link ?? ""))), publishedAt: item?.providerPublishTime ? new Date(Number(item.providerPublishTime) * 1000).toISOString() : null, domain: safeDomain(String(item?.link ?? "")), sourceType: "market", score, stance: stance(score) };
    }).filter((item: ResearchArticle) => item.title && item.url);
    return { companyName, articles };
  } catch { return { companyName: null, articles: [] as ResearchArticle[] }; }
}

async function gdeltResearch(query: string, sourceType: ResearchArticle["sourceType"] = "news") {
  try {
    const url = `${GDELT_DOC}?query=${encodeURIComponent(query)}&mode=artlist&format=json&maxrecords=25&timespan=3d&sort=DateDesc`;
    const payload = await fetchJson(url, 8000);
    const items = Array.isArray(payload?.articles) ? payload.articles : [];
    return items.map((item: any) => {
      const title = String(item?.title ?? "").trim();
      const score = scoreText(title);
      return { title, url: String(item?.url ?? ""), source: String(item?.domain ?? "GDELT"), publishedAt: item?.seendate ? parseGdeltDate(String(item.seendate)) : null, language: item?.language, domain: String(item?.domain ?? ""), sourceType, score, stance: stance(score) } satisfies ResearchArticle;
    }).filter((item: ResearchArticle) => item.title && item.url);
  } catch { return [] as ResearchArticle[]; }
}

function parseGdeltDate(value: string) {
  if (/^\d{14}$/.test(value)) return new Date(`${value.slice(0,4)}-${value.slice(4,6)}-${value.slice(6,8)}T${value.slice(8,10)}:${value.slice(10,12)}:${value.slice(12,14)}Z`).toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function buildResearch(symbolInput: string): Promise<ResearchResult> {
  const symbol = symbolInput.trim().toUpperCase();
  const yahoo = await yahooResearch(symbol);
  const queryParts = [symbol];
  if (yahoo.companyName) queryParts.push(`"${yahoo.companyName}"`);
  const news = await gdeltResearch(`(${queryParts.join(" OR ")})`, "news");
  const officialQuery = [symbol, yahoo.companyName ? `"${yahoo.companyName}"` : ""].filter(Boolean).join(" OR ");
  const official = await gdeltResearch(`(${officialQuery}) (domain:nseindia.com OR domain:sebi.gov.in)`, "official");

  const dedupe = new Set<string>();
  const articles = [...official, ...yahoo.articles, ...news].filter(article => {
    const key = article.url.replace(/^https?:\/\//, "").replace(/\/$/, "");
    if (!key || dedupe.has(key)) return false;
    dedupe.add(key);
    return true;
  }).sort((a, b) => (b.publishedAt ? Date.parse(b.publishedAt) : 0) - (a.publishedAt ? Date.parse(a.publishedAt) : 0)).slice(0, 30);

  const weight = (article: ResearchArticle) => article.sourceType === "official" ? 1.7 : article.sourceType === "news" ? 1 : 0.8;
  const totalWeight = articles.reduce((sum, article) => sum + weight(article), 0) || 1;
  const weightedScore = articles.reduce((sum, article) => sum + article.score * weight(article), 0) / totalWeight;
  const bullish = articles.filter(article => article.stance === "BULLISH").length;
  const bearish = articles.filter(article => article.stance === "BEARISH").length;
  const directional = bullish + bearish;
  const agreement = directional ? Math.max(bullish, bearish) / directional : 0;
  const sourceCount = new Set(articles.map(article => article.domain || article.source)).size;
  const officialCount = articles.filter(article => article.sourceType === "official").length;
  const freshnessCount = articles.filter(article => article.publishedAt && Date.now() - Date.parse(article.publishedAt) <= 24 * 60 * 60 * 1000).length;
  const evidenceScore = Math.round(Math.max(0, Math.min(100, 30 + weightedScore * 25 + Math.min(sourceCount, 10) * 3 + Math.min(freshnessCount, 10) * 2 + Math.min(officialCount, 5) * 5)));
  const confidence = Number(Math.max(0.05, Math.min(0.95, 0.3 + Math.abs(weightedScore) * 0.3 + agreement * 0.2 + Math.min(sourceCount, 8) * 0.02 + Math.min(officialCount, 3) * 0.03)).toFixed(3));
  let direction: ResearchResult["direction"] = "MIXED";
  if (Math.abs(weightedScore) >= 0.18 && agreement >= 0.55) direction = weightedScore > 0 ? "BULLISH" : "BEARISH";

  const themes = Array.from(new Set(TOPIC_TERMS.filter(([term]) => articles.some(article => article.title.toLowerCase().includes(term))).map(([, label]) => label))).slice(0, 8);
  const risks = Array.from(new Set(TOPIC_TERMS.filter(([term]) => ["fraud", "investigation", "sebi", "regulator", "lawsuit", "debt", "delay"].some(risk => term.includes(risk)) && articles.some(article => article.title.toLowerCase().includes(term))).map(([, label]) => label))).slice(0, 6);

  return {
    symbol, companyName: yahoo.companyName, asOf: new Date().toISOString(), direction, confidence, evidenceScore,
    agreement: Number(agreement.toFixed(3)), articles, themes, risks,
    publicDisclosureLinks: [
      { label: "NSE corporate announcements", url: `https://www.nseindia.com/companies-listing/corporate-filings-announcements?symbol=${encodeURIComponent(symbol)}&tabIndex=equity` },
      { label: "NSE public insider-trading disclosures", url: `https://www.nseindia.com/companies-listing/corporate-filings-insider-trading?symbol=${encodeURIComponent(symbol)}` },
      { label: "SEBI filings search", url: "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=3&smid=11" },
    ],
    disclaimer: "Research uses publicly available sources. It does not access or infer illegal non-public inside information. Public insider-trading disclosures, exchange filings and regulatory records are treated as evidence. Probability is a calibrated research score, not a guarantee or trading advice.",
  };
}
