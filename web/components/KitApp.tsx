"use client";
/* Ported from the Claude Design export (ui_kits/marketplace/App.jsx).
   The state routing is the design's, unchanged: `route` drives the screen,
   `hired` / `hiring` / `empty` / `sheet` are still local mock state. The only
   change is the wallet: the design's `connected` boolean and `onConnect`
   handler are gone, because the header now reads real wagmi state. Mounting is
   Next's job, so the export's `mountKit()` polling loop is dropped. */
import React from "react";

import { AGENTS } from "@/lib/design-data";
import { KitHeader } from "@/components/screens/KitHeader";
import { MarketplaceScreen } from "@/components/screens/MarketplaceScreen";
import { AgentDetailScreen } from "@/components/screens/AgentDetailScreen";
import { NearDeployScreen } from "@/components/near/NearDeployScreen";
import { ListAgentScreen } from "@/components/screens/ListAgentScreen";
import { NearAccountScreen } from "@/components/near/NearAccountScreen";
import { NearJobScreen } from "@/components/near/NearJobScreen";
import { NearTradeDeployScreen } from "@/components/near/NearTradeDeployScreen";
import { NearMemeScreen } from "@/components/near/NearMemeScreen";
import { NearDemoScreen } from "@/components/near/NearDemoScreen";
import { SigmaPet } from "@/components/SigmaPet";
import { dispatchSigmaPetReaction } from "@/lib/sigma-pet";

export function KitApp() {
  const [route, setRoute] = React.useState("/");
  const [sheet, setSheet] = React.useState(false);
  const [search, setSearch] = React.useState("");

  // URL <-> state route sync: the initial route comes from the address bar (so
  // `/account/<id>` deep links and reloads work through the catch-all page), `go`
  // pushes history, and back/forward restore the state route. Read in an
  // effect, not in the initialiser, so the server render and the first client
  // render agree.
  React.useEffect(() => {
    const normalize = (path: string) => path === "/my" || path.startsWith("/my/") ? `/account${path.slice(3)}` : path;
    const fromUrl = normalize(window.location.pathname);
    if (fromUrl !== "/" && fromUrl !== route) {
      setRoute(fromUrl);
      if (fromUrl !== window.location.pathname) window.history.replaceState(null, "", fromUrl);
    }
    const onPop = () => setRoute(normalize(window.location.pathname || "/"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const onResize = () => setSheet(window.innerWidth < 720);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const go = (r: string) => {
    if (r === "/deploy/trading") r = "/deploy/trade";
    setRoute(r);
    if (window.location.pathname !== r) window.history.pushState(null, "", r);
    window.scrollTo(0, 0);
  };
  const agentFrom = (prefix: string) => AGENTS.find((a) => a.id === route.slice(prefix.length)) || AGENTS[0];

  let screen;
  if (route.startsWith("/agent/")) screen = <AgentDetailScreen agent={agentFrom("/agent/")} go={go} />;
  else if (route.startsWith("/meme/")) screen = <NearMemeScreen key={route} agentId={route.slice("/meme/".length)} go={go} />;
  else if (route.startsWith("/demo/")) screen = <NearDemoScreen key={route} agentId={route.slice("/demo/".length)} go={go} />;
  // Trade V1 section 14: the selected execution model lives in the route.
  // Operator, 2026-11-13: the Trading Agent tab opens Schedule buy; the Degen paper agent has its own route.
  else if (route === "/deploy/trade" || route === "/deploy/trade/schedule" || route === "/deploy/trade/dca" || route === "/deploy/trade/degen") screen = <NearTradeDeployScreen go={go}
    model={route === "/deploy/trade/degen" ? "degen" : route === "/deploy/trade/dca" ? "dca" : "schedule"} />;
  else if (route.startsWith("/account/")) screen = <NearJobScreen key={route.slice("/account/".length)} jobId={route.slice("/account/".length)} go={go} />;
  else if (route === "/deploy/grid" || route === "/deploy/lp") screen = <NearDeployScreen key={route} kind={route === "/deploy/lp" ? "lp" : "grid"} go={go} />;
  else if (route === "/account") screen = <NearAccountScreen go={go} />;
  else if (route === "/list-your-agent") screen = <ListAgentScreen go={go} />;
  else screen = <MarketplaceScreen go={go} search={search} />;

  return (
    <div className="fl-page">
      <KitHeader route={route} go={go} search={search} onSearchChange={setSearch} />
      {screen}
      {/* Decoration only — the pet reads no state and calls nothing. */}
      <SigmaPet route={route} />
    </div>
  );
}
