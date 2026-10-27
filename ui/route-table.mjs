const routes = [
  { pattern: "/", page: "dashboard", component: "page-dashboard", template: "/assets/pages/dashboard.html" },
  { pattern: "/runs", page: "dashboard", component: "page-dashboard", template: "/assets/pages/dashboard.html" },
  {
    pattern: "/runs/:jobId(\\d+)",
    page: "run",
    component: "page-run",
    template: (params) => `/assets/pages/run.html?jobId=${encodeURIComponent(params.jobId)}`,
    transient: true,
  },
  {
    pattern: "/workspaces/:workspaceId/invocations/:invocationId",
    page: "invocation",
    component: "page-invocation",
    transient: true,
  },
  { pattern: "/help", page: "help", component: "page-help", template: "/assets/pages/help.html" },
  { pattern: "/settings", page: "settings", component: "page-settings", template: "/assets/pages/settings.html" },
  {
    pattern: "/operations",
    page: "operations",
    component: "page-operations",
    template: "/assets/pages/operations.html",
  },
  { pattern: "/channels", page: "channels", component: "page-channels" },
  { pattern: "/teams", page: "workspaces", component: "page-teams", template: "/assets/pages/workspaces.html" },
  { pattern: "/workspaces", page: "workspaces", component: "page-teams", template: "/assets/pages/workspaces.html" },
  {
    pattern: "/workspaces/:workspaceId/workflows",
    page: "workflows",
    component: "page-workflows",
    template: (params) =>
      `/assets/pages/workflows.html?page=workflows&workspaceId=${encodeURIComponent(params.workspaceId)}`,
    transient: true,
  },
  {
    pattern: "/workspaces/:workspaceId/workflows/:workflowId",
    page: "editor",
    component: "page-workflow-editor",
    template: (params, url) =>
      `/assets/pages/workflows.html?page=editor&id=${encodeURIComponent(params.workflowId)}&workspaceId=${encodeURIComponent(params.workspaceId)}${url.searchParams.get("revision") ? `&revision=${encodeURIComponent(url.searchParams.get("revision"))}` : ""}`,
    transient: true,
  },
  {
    pattern: "/workspaces/:workspaceId/runs/events",
    page: "incoming-events",
    component: "page-incoming-events",
    template: (params) => `/assets/pages/incoming-events.html?workspaceId=${encodeURIComponent(params.workspaceId)}`,
    transient: true,
  },
  { pattern: "/workspaces/:workspaceId/channels", page: "channels", component: "page-channels" },
  {
    pattern: "/workspaces/:workspaceId/channels/:channelId",
    page: "channels",
    component: "page-channels",
  },
  {
    pattern: "/workspaces/:workspaceId/runs",
    page: "dashboard",
    component: "page-dashboard",
    template: "/assets/pages/dashboard.html",
  },
  {
    pattern: "/workspaces/:workspaceId/settings",
    page: "team-settings",
    component: "page-team-settings",
    template: (params) => `/assets/pages/team-settings.html?teamId=${encodeURIComponent(params.workspaceId)}`,
    transient: true,
  },
  {
    pattern: "/teams/:workspaceId/settings",
    page: "team-settings",
    component: "page-team-settings",
    template: (params) => `/assets/pages/team-settings.html?teamId=${encodeURIComponent(params.workspaceId)}`,
    transient: true,
  },
  {
    pattern: "/workflows/:workflowId",
    page: "editor",
    component: "page-workflow-editor",
    template: (params, url) =>
      `/assets/pages/workflows.html?page=editor&id=${encodeURIComponent(params.workflowId)}${url.searchParams.get("revision") ? `&revision=${encodeURIComponent(url.searchParams.get("revision"))}` : ""}`,
    queryWorkspace: true,
    transient: true,
  },
  {
    pattern: "/workflows",
    page: "workflows",
    component: "page-workflows",
    template: "/assets/pages/workflows.html?page=workflows",
  },
  {
    pattern: "/recipes",
    page: "recipes",
    component: "page-recipes",
    template: "/assets/pages/recipes.html",
    global: true,
  },
  {
    pattern: "/recipes/new",
    page: "recipe-editor",
    component: "page-recipe-editor",
    template: "/assets/pages/recipes.html?editor=1",
    global: true,
  },
];

const compiledRoutes = routes.map((route) => ({ ...route, matcher: new URLPattern({ pathname: route.pattern }) }));

export function matchRoute(input) {
  const url = input instanceof URL ? input : new URL(input, globalThis.location?.origin || "http://localhost");
  const pathname =
    url.pathname === "/ui" ? "/" : url.pathname.startsWith("/ui/") ? url.pathname.slice(3) : url.pathname;
  const normalizedUrl = new URL(url.href);
  normalizedUrl.pathname = pathname;

  for (const route of compiledRoutes) {
    const match = route.matcher.exec(normalizedUrl);
    if (!match) {
      continue;
    }
    let params;
    try {
      params = Object.fromEntries(
        Object.entries(match.pathname.groups).map(([key, value]) => [key, decodeURIComponent(value)]),
      );
    } catch {
      return { component: "page-not-found", page: "not-found", notFound: true };
    }
    if (params.workflowId && !/^(?:new|[a-z0-9-]+)$/.test(params.workflowId)) {
      continue;
    }
    let teamId = params.workspaceId;
    if (route.queryWorkspace) {
      teamId = url.searchParams.get("workspaceId") || "";
    }
    if (route.page === "run") {
      teamId = url.searchParams.get("workspaceId") || "";
    }
    return {
      page: route.page,
      component: route.component,
      ...(route.template
        ? { url: typeof route.template === "function" ? route.template(params, url) : route.template }
        : {}),
      ...(teamId ? { teamId } : {}),
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.invocationId ? { invocationId: params.invocationId } : {}),
      ...(params.jobId ? { jobId: params.jobId } : {}),
      ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      params: {
        ...params,
        ...(url.searchParams.has("revision") ? { revision: url.searchParams.get("revision") } : {}),
        ...(route.queryWorkspace ? { workspaceId: url.searchParams.get("workspaceId") || "" } : {}),
        ...(route.page === "run" && url.searchParams.has("workspaceId")
          ? { workspaceId: url.searchParams.get("workspaceId") }
          : {}),
      },
      ...(route.global ? { global: true } : {}),
      ...(route.transient ? { transient: true } : {}),
    };
  }
  return { component: "page-not-found", page: "not-found", notFound: true };
}

export const routeDefinitions = routes.map(({ pattern, page, component }) => ({ pattern, page, component }));
