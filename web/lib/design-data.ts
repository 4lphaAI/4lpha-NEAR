/* Ported verbatim from the Claude Design export (ui_kits/marketplace/data.js).
   Only the trailing `Object.assign(window, ...)` was replaced by ES exports. */
import { agenticDcaEnabled, agenticEnabled } from "./agentic";

export interface AgentMetric { label: string; value: string; tone?: string; note?: string }
export interface AgentActivity { title: string; detail: string; time: string; txHash?: string; icon?: string; tone?: string }

/** One catalogue agent. Everything past id/name is optional because the design own
    data set fills only what each card needs. */
export interface Agent {
  id: string;
  name: string;
  categoryId: string;
  protocol: string;
  tier: string;
  status: string;
  tagline: string;
  /** Picks the animated explainer the detail page renders for this agent. */
  explainer?: string;
  /** Extra venue logos rendered beside the protocol logo on the card meta row. */
  relatedProtocols?: string[];
  venues?: string[];
  /** Custody options shown on the card spec row; absent means Altana only. */
  custody?: string[];
  metricValue: string;
  metricTone?: string;
  metricLabel?: string;
  hiredCount: number;
  price: string;
  priceUnit: string;
  pair?: string;
  dailyCap?: string;
  series?: number[];
  metrics?: AgentMetric[];
  activity?: AgentActivity[];
  statusLine?: string;
  disabled?: boolean;
  /** The card shows only the Demo badge and Try demo now: no tier badge, no Hire Now (the paper meme agent). */
  demoOnly?: boolean;
}

/** Public deploy route for the hire action on marketplace and detail cards. */
export function agentDeployKind(agent: Pick<Agent, "categoryId" | "id">): "grid" | "trading" | "trade/schedule" | "trade/dca" | "trade/degen" | "lp" | "lending" {
  // Trade V1 section 14: the two live trading agents open their own card on the trade deploy screen.
  if (agent.id === "recurring-buy") return "trade/schedule";
  if (agent.id === "auto-dca") return "trade/dca";
  // Operator, 2026-11-14: the paper meme agent opens its own Degen card.
  if (agent.id === "ai-token-trader") return "trade/degen";
  if (agent.categoryId === "grid") return "grid";
  if (agent.categoryId === "trading") return "trading";
  if (agent.categoryId === "lp") return "lp";
  return "lending";
}

/** Catalogue cards whose deploy page offers the no-funds demo: Grid (Grid Keeper and Ladder NEAR), LP, Schedule buy,
    Auto DCA and the paper meme agent. */
const DEMO_AGENT_IDS = new Set(["grid-keeper", "ladder-near", "range-pilot", "aegis-lp", "recurring-buy", "auto-dca", "ai-token-trader"]);
export function agentHasDemo(agent: Pick<Agent, "id" | "tier">): boolean {
  return DEMO_AGENT_IDS.has(agent.id) && agent.tier !== "coming-soon";
}

/** Opens a deploy route in the given mode: writes the remembered Demo | Live choice the deploy screens read, then navigates.
    Try demo now opens Demo; Hire Now opens Live (real funds on mainnet). */
export function openDeploy(go: (route: string) => void, route: string, mode: "demo" | "live"): void {
  try { window.localStorage.setItem("fourlpha_deploy_mode", mode); } catch { /* Browser storage can be unavailable. */ }
  go(route);
}
export const openDemo = (go: (route: string) => void, route: string): void => openDeploy(go, route, "demo");
export const openLive = (go: (route: string) => void, route: string): void => openDeploy(go, route, "live");

/** A hired-agent overlay, merged over the catalogue Agent by route. */
export interface HiredAgent {
  id: string;
  value: string;
  valueTone?: string;
  valueSub: string;
  status?: string;
  warning?: boolean;
  statusLine?: string;
}

export const AGENTS: Agent[] = [
  { id: "grid-keeper", name: "Grid Keeper", categoryId: "grid", protocol: "Rhea DCL", tier: "verified", status: "live",
    tagline: "Limit-order grid on USDC / wNEAR, Rhea DCL.",
    metricValue: "New", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "this month", pair: "USDC / wNEAR", dailyCap: "1 to 2 NEAR" },
  { id: "ladder-near", name: "Ladder NEAR", categoryId: "grid", protocol: "Rhea DCL", tier: "verified", status: "live", disabled: false,
    tagline: "A buy and sell ladder around the NEAR price.",
    metricValue: "-", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "this month", pair: "USDt / wNEAR" },
  { id: "range-pilot", name: "Range Pilot", categoryId: "lp", protocol: "Rhea DCL", tier: "verified", status: "live", disabled: false, relatedProtocols: ["NEAR AI"],
    tagline: "Keeps your Rhea DCL range on the price.",
    metricValue: "-", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "this month", pair: "USDC / wNEAR" },
  { id: "aegis-lp", name: "Aegis LP", categoryId: "lp", protocol: "Rhea DCL", tier: "verified", status: "live", explainer: "compound", disabled: false, relatedProtocols: ["NEAR AI"],
    tagline: "Compounds your Rhea DCL fees back in.",
    metricValue: "-", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "this month", pair: "USDC / wNEAR" },
  { id: "ai-token-trader", name: "AI Quant Trader", categoryId: "trading", protocol: "meme.cooking", tier: "verified", status: "live", explainer: "trade", disabled: false, demoOnly: true,
    tagline: "Joins meme.cooking auctions on paper, AI-gated.",
    metricValue: "-", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "paper only", pair: "Paper auctions. No real orders." },
  { id: "recurring-buy", name: "Recurring Buy", categoryId: "trading", protocol: "Rhea", tier: "verified", status: "live", explainer: "schedule",
    tagline: "Buys a fixed amount of a token on schedule.",
    metricValue: "-", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "this month" },
  { id: "auto-dca", name: "Auto DCA Agent", categoryId: "trading", protocol: "Rhea", tier: "verified", status: "live", explainer: "dca",
    tagline: "Buys more on dips, sells at your target.",
    metricValue: "-", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "this month" },
  { id: "smart-portfolio", name: "Smart Portfolio", categoryId: "trading", protocol: "Rhea", tier: "coming-soon", status: "live", explainer: "smart", disabled: true,
    tagline: "Holds a token basket at your target weights.",
    metricValue: "-", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "this month" },
  { id: "health-guard", name: "Health Guard", categoryId: "health", protocol: "Rhea Lend", tier: "coming-soon", status: "live", explainer: "lending", disabled: true,
    tagline: "Repays your Rhea Lend debt before liquidation.",
    metricValue: "-", metricTone: "flat", hiredCount: 0, price: "0 Fees", priceUnit: "this month" },
];

export const HIRED: HiredAgent[] = [];
