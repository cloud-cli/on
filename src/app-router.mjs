import { getElement, load, onDestroy, onInit, templateRef } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export function navigateTo(path) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function () {
  const outlet = templateRef("outlet");
  let navigationId = 0;
  const mountedPages = new Map();
  let activeTransientPage = null;
  let routeMessage = null;
  const checkTeams = async () => {
    const response = await apiFetch("/api/teams", { headers: { accept: "application/json" } });
    if (!response.ok)
      throw new Error(`Unable to check your teams (${response.status}). Please reload or sign in again.`);
    const result = await response.json();
    const teams = result.teams || [];
    if (teams.length) {
      const selected = localStorage.getItem("runner-team-id");
      if (!teams.some((team) => team.id === selected)) localStorage.setItem("runner-team-id", teams[0].id);
    }
    return teams;
  };
  const showOnboarding = () => {
    document.body.dataset.teamless = "true";
    for (const page of mountedPages.values()) page.hidden = true;
    activeTransientPage?.remove();
    activeTransientPage = null;
    routeMessage?.remove();
    const main = document.createElement("main");
    main.className = "mx-auto mt-16 w-full max-w-lg rounded-2xl border border-flow-border bg-white p-8 shadow-sm";
    main.innerHTML =
      '<p class="text-sm font-semibold uppercase tracking-wide text-flow-primary">Welcome to Flow</p><h1 class="mt-3 text-2xl font-semibold">Create your first team</h1><p class="mt-2 text-sm text-flow-secondary">Teams keep your workflows, runs, and secrets together.</p><form class="mt-6 space-y-4"><label class="block text-sm font-medium" for="first-team-name">Team name</label><input id="first-team-name" name="name" required maxlength="100" autocomplete="organization" class="w-full rounded-lg border border-flow-border px-3 py-2" placeholder="Acme Engineering"><p class="hidden text-sm text-rose-700" role="alert"></p><button class="rounded-lg bg-flow-primary px-4 py-2 font-semibold text-white">Create team</button></form>';
    const form = main.querySelector("form");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const button = form.querySelector("button");
      const alert = form.querySelector('[role="alert"]');
      let teamCreated = false;
      const name = new FormData(form).get("name").trim();
      if (!name) return;
      button.disabled = true;
      button.textContent = "Creating…";
      alert.classList.add("hidden");
      try {
        const response = await apiFetch("/api/teams", {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(result.error || `Team creation failed (${response.status}). Please try again.`);
        const team = result.team || result;
        if (!team.id)
          throw new Error("Team was created but the response had no team ID. Reload and select your team in Settings.");
        teamCreated = true;
        localStorage.setItem("runner-team-id", team.id);
        document.body.dataset.teamless = "false";
        window.dispatchEvent(new Event("runner-teams-updated"));
        main.querySelector("form").remove();
        const success = document.createElement("section");
        success.className = "mt-6 space-y-3 text-sm";
        const confirmation = document.createElement("p");
        confirmation.textContent = `Team “${team.name || name}” created successfully.`;
        success.append(confirmation);
        if (result.webhookPath) {
          const webhook = document.createElement("p");
          webhook.className = "break-all rounded-lg bg-flow-sidebar p-3";
          webhook.textContent = `Webhook endpoint: ${result.webhookPath}`;
          success.append(webhook);
        }
        const continueButton = document.createElement("button");
        continueButton.className = "rounded-lg bg-flow-primary px-4 py-2 font-semibold text-white";
        continueButton.textContent = "Continue to Flow";
        continueButton.addEventListener("click", () => void navigate(true));
        success.append(continueButton);
        main.append(success);
      } catch (error) {
        alert.textContent = teamCreated
          ? "Your team was created, but this browser could not save the selected team. Enable browser storage, then reload."
          : error.message || "Unable to create team. Please try again.";
        alert.classList.remove("hidden");
        button.disabled = teamCreated;
        button.textContent = teamCreated ? "Team created" : "Create team";
      }
    });
    routeMessage = main;
    outlet.value.replaceChildren(main);
  };
  const route = () => {
    const url = new URL(window.location.href);
    const path = url.pathname;
    if (path === "/" || path === "/runs")
      return { component: "page-dashboard", url: "/pages/dashboard.html", page: "dashboard" };
    if (path.match(/^\/runs\/\d+$/))
      return { component: "page-run", url: `/pages/run.html?jobId=${path.split("/").pop()}`, page: "run" };
    if (path === "/help") return { component: "page-help", url: "/pages/help.html", page: "help" };
    if (path === "/settings") return { component: "page-settings", url: "/pages/settings.html", page: "settings" };
    if (path === "/teams") return { component: "page-teams", url: "/pages/teams.html", page: "teams" };
    const teamSettings = path.match(/^\/teams\/([^/]+)\/settings$/);
    if (teamSettings)
      return {
        component: "page-team-settings",
        url: `/pages/team-settings.html?teamId=${encodeURIComponent(teamSettings[1])}`,
        page: "team-settings",
        teamId: decodeURIComponent(teamSettings[1]),
      };
    if (path === "/workflows")
      return { component: "page-workflows", url: "/pages/workflows.html?page=workflows", page: "workflows" };
    const legacyEditor = path.match(/^\/workflows\/(new|[a-z0-9-]+)$/);
    if (legacyEditor)
      return {
        component: "page-workflow-editor",
        url: `/pages/workflows.html?page=editor&id=${legacyEditor[1]}${url.searchParams.get("revision") ? `&revision=${url.searchParams.get("revision")}` : ""}`,
        page: "editor",
      };
    return { component: "page-not-found", page: "not-found" };
  };
  const navigate = async (replace = false) => {
    const currentNavigation = ++navigationId;
    try {
      const teams = await checkTeams();
      if (currentNavigation !== navigationId) return;
      if (!teams.length) {
        showOnboarding();
        return;
      }
      document.body.dataset.teamless = "false";
      const current = route();
      if (current.teamId) {
        if (!teams.some((team) => team.id === current.teamId)) throw new Error("You are not a member of this team.");
        localStorage.setItem("runner-team-id", current.teamId);
      }
      document.body.dataset.page = current.page;
      activeTransientPage?.remove();
      activeTransientPage = null;
      routeMessage?.remove();
      routeMessage = null;
      if (current.page === "not-found") {
        for (const page of mountedPages.values()) page.hidden = true;
        routeMessage = document.createElement("main");
        routeMessage.className = "mx-auto max-w-4xl p-8";
        routeMessage.innerHTML =
          '<h1 class="text-xl font-semibold">404 — Page not found</h1><p class="mt-2 text-sm">The page you are looking for does not exist. <a href="/">Go home</a> or <a href="/runs">view runs</a>.</p>';
        outlet.value.append(routeMessage);
      } else {
        const persistentPage = !["run", "editor", "team-settings"].includes(current.page);
        const cacheKey = current.page;
        let component = persistentPage ? mountedPages.get(cacheKey) : null;
        if (!component) {
          await load(current.url);
          if (currentNavigation !== navigationId) return;
          if (current.teamId) localStorage.setItem("runner-team-id", current.teamId);
          component = document.createElement(current.component);
          component.dataset.routePage = current.page;
          if (persistentPage) {
            mountedPages.set(cacheKey, component);
            outlet.value.append(component);
          } else {
            activeTransientPage = component;
            outlet.value.append(component);
          }
        }
        for (const page of mountedPages.values()) {
          page.hidden = page !== component;
        }
        if (window.location.hash) {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => document.querySelector(window.location.hash)?.scrollIntoView()),
          );
        }
      }
      if (replace) history.replaceState(null, "", window.location.href);
    } catch (error) {
      if (currentNavigation !== navigationId) return;
      for (const page of mountedPages.values()) page.hidden = true;
      activeTransientPage?.remove();
      activeTransientPage = null;
      routeMessage?.remove();
      routeMessage = document.createElement("main");
      routeMessage.className = "mx-auto max-w-4xl p-8";
      const heading = document.createElement("h1");
      heading.className = "text-xl font-semibold text-white";
      heading.textContent = "Unable to load page";
      const message = document.createElement("p");
      message.className = "mt-2 text-sm text-rose-300";
      message.textContent = String(error.message || error);
      routeMessage.append(heading, message);
      outlet.value.append(routeMessage);
    }
  };
  const handleClick = (event) => {
    const anchor = event.target.closest?.("a");
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const target = new URL(anchor.href, window.location.href);
    if (
      target.origin !== window.location.origin ||
      !target.pathname.startsWith("/") ||
      target.pathname.startsWith("/auth/") ||
      target.pathname === "/teams/accept"
    )
      return;
    if (target.pathname.startsWith("/api/") || target.pathname.startsWith("/webhooks/")) return;
    if (target.pathname === window.location.pathname && target.hash) return;
    event.preventDefault();
    history.pushState(null, "", `${target.pathname}${target.search}${target.hash}`);
    void navigate();
  };
  const handlePopState = () => void navigate();
  const element = getElement();
  onInit(() => {
    document.addEventListener("click", handleClick);
    window.addEventListener("popstate", handlePopState);
    void navigate(true);
  });
  onDestroy(() => {
    document.removeEventListener("click", handleClick);
    window.removeEventListener("popstate", handlePopState);
  });
  return {};
}
