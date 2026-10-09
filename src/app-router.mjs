import { getElement, load, onDestroy, onInit, templateRef } from "@li3/web";

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
  const route = () => {
    const url = new URL(window.location.href);
    const path = url.pathname;
    if (path === "/" || path === "/runs")
      return { component: "page-dashboard", url: "/pages/dashboard.html", page: "dashboard" };
    if (path.match(/^\/runs\/\d+$/))
      return { component: "page-run", url: `/pages/run.html?jobId=${path.split("/").pop()}`, page: "run" };
    if (path === "/help") return { component: "page-help", url: "/pages/help.html", page: "help" };
    if (path === "/settings") return { component: "page-settings", url: "/pages/settings.html", page: "settings" };
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
      const current = route();
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
        const persistentPage = !["run", "editor"].includes(current.page);
        const cacheKey = current.page;
        let component = persistentPage ? mountedPages.get(cacheKey) : null;
        if (!component) {
          await load(current.url);
          if (currentNavigation !== navigationId) return;
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
      target.pathname.startsWith("/auth/")
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
