import { load, onDestroy, onInit, ref, templateRef } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";
import { mountChannels } from "@app/channels-ui.mjs";
import { mountInvocation } from "@app/invocation-ui.mjs";
import { matchRoute } from "@app/route-table.mjs";

export function navigateTo(path) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function () {
  const outlet = templateRef("outlet");
  let navigationId = 0;
  const mountedPages = new Map();
  let activeTransientPage = null;
  const transientView = ref("");
  const statusMessage = ref("Loading your workspace…");
  const routeError = ref("");
  const retryLabel = ref("Try again");
  const workspaceName = ref("");
  const creatingWorkspace = ref(false);
  const onboardingError = ref("");
  const workspaceCreationComplete = ref(false);
  const createdWorkspaceName = ref("");
  const createdWebhookPath = ref("");
  const checkTeams = async () => {
    const response = await apiFetch("/api/v1/workspaces", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`Unable to check your workspaces (${response.status}). Please reload or sign in again.`);
    }

    const result = await response.json();
    const teams = result.workspaces || [];
    if (teams.length) {
      const selected = localStorage.getItem("runner-team-id");
      if (!teams.some((team) => team.id === selected)) {
        localStorage.setItem("runner-team-id", teams[0].id);
      }
    }
    return teams;
  };
  const showOnboarding = () => {
    document.body.dataset.teamless = "true";
    for (const page of mountedPages.values()) {
      page.hidden = true;
    }
    activeTransientPage?.remove();
    activeTransientPage = null;
    transientView.value = "onboarding";
  };
  const route = () => matchRoute(window.location.href);
  const createWorkspace = async (event) => {
    event.preventDefault();
    const name = workspaceName.value.trim();
    if (!name || creatingWorkspace.value) {
      return;
    }
    creatingWorkspace.value = true;
    onboardingError.value = "";
    let teamCreated = false;
    try {
      const response = await apiFetch("/api/v1/workspaces", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || `Workspace creation failed (${response.status}). Please try again.`);
      }
      const team = result.workspace || result;
      if (!team.id) {
        throw new Error("Workspace was created but the response had no ID. Reload and select it in Settings.");
      }

      teamCreated = true;
      workspaceCreationComplete.value = true;
      createdWorkspaceName.value = team.name || name;
      createdWebhookPath.value = result.webhookPath || "";
      localStorage.setItem("runner-team-id", team.id);
      document.body.dataset.teamless = "false";
      window.dispatchEvent(new Event("runner-teams-updated"));
      creatingWorkspace.value = false;
    } catch (error) {
      onboardingError.value = teamCreated
        ? "Your workspace was created, but this browser could not save the selection. Enable browser storage, then reload."
        : error.message || "Unable to create workspace. Please try again.";
      if (teamCreated) {
        workspaceName.value = "";
      }
      creatingWorkspace.value = false;
    }
  };
  const continueToWorkspace = () => void navigate(true);
  const retryNavigation = () => {
    retryLabel.value = "Trying again…";
    void navigate(true);
  };
  const navigate = async (replace = false) => {
    const currentNavigation = ++navigationId;
    try {
      const current = route();
      if (!current.global && !mountedPages.size && !activeTransientPage) {
        document.body.dataset.teamless = "false";
        statusMessage.value = "Loading your workspace…";
        transientView.value = "loading";
      }
      let teams = current.global ? [] : await checkTeams();
      if (currentNavigation !== navigationId) {
        return;
      }
      if (!teams.length && current.page !== "recipes" && current.page !== "recipe-editor") {
        showOnboarding();
        return;
      }
      document.body.dataset.teamless = "false";
      if (current.teamId) {
        if (!teams.some((team) => team.id === current.teamId)) {
          throw new Error("You are not a member of this team.");
        }
        if (localStorage.getItem("runner-team-id") !== current.teamId) {
          localStorage.setItem("runner-team-id", current.teamId);
          window.dispatchEvent(new CustomEvent("runner-team-changed", { detail: { teamId: current.teamId } }));
        }
      }
      document.body.dataset.page = current.page;
      activeTransientPage?.remove();
      activeTransientPage = null;
      if (current.page === "not-found") {
        for (const page of mountedPages.values()) {
          page.hidden = true;
        }
        transientView.value = "not-found";
      } else {
        transientView.value = "";
        const persistentPage = !current.transient;
        const cacheKey = current.teamId ? `${current.page}:${current.teamId}` : current.page;
        let component = persistentPage ? mountedPages.get(cacheKey) : null;
        if (!component) {
          if (current.url) {
            await load(current.url);
          }
          if (currentNavigation !== navigationId) {
            return;
          }
          if (current.teamId) {
            localStorage.setItem("runner-team-id", current.teamId);
          }
          component = document.createElement(current.component);
          component.routeParams = Object.freeze({
            page: current.page,
            teamId: current.teamId || "",
            ...(current.params || {}),
          });
          component.dataset.routePage = current.page;
          if (current.page === "channels") {
            component.dataset.workspaceId = current.teamId || "";
            mountChannels(component, component.routeParams);
          }
          if (current.page === "invocation") {
            component.dataset.workspaceId = current.teamId;
            component.dataset.invocationId = current.invocationId;
            mountInvocation(component, component.routeParams);
          }
          if (persistentPage) {
            mountedPages.set(cacheKey, component);
            outlet.value.append(component);
          } else {
            activeTransientPage = component;
            outlet.value.append(component);
          }
        } else {
          component.routeParams = Object.freeze({
            page: current.page,
            teamId: current.teamId || "",
            ...(current.params || {}),
          });
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
      if (replace) {
        history.replaceState(null, "", window.location.href);
      }
      window.dispatchEvent(new CustomEvent("runner-route-changed", { detail: { pathname: window.location.pathname } }));
    } catch (error) {
      if (currentNavigation !== navigationId) {
        return;
      }
      document.body.dataset.teamless = "false";
      for (const page of mountedPages.values()) {
        page.hidden = true;
      }
      activeTransientPage?.remove();
      activeTransientPage = null;
      routeError.value = String(error.message || error);
      retryLabel.value = "Try again";
      transientView.value = "error";
    }
  };
  const handleClick = (event) => {
    const anchor = event.target.closest?.("a");
    if (!anchor || anchor.target || anchor.hasAttribute("download")) {
      return;
    }
    const target = new URL(anchor.href, window.location.href);
    if (
      target.origin !== window.location.origin ||
      !target.pathname.startsWith("/") ||
      target.pathname.startsWith("/auth/") ||
      target.pathname === "/ui/teams/accept"
    ) {
      return;
    }
    if (target.pathname.startsWith("/api/v1/") || target.pathname.startsWith("/assets/")) {
      return;
    }
    if (target.pathname === window.location.pathname && target.hash) {
      return;
    }
    event.preventDefault();
    history.pushState(null, "", `${target.pathname}${target.search}${target.hash}`);
    void navigate();
  };
  const handlePopState = () => void navigate();
  onInit(() => {
    document.addEventListener("click", handleClick);
    window.addEventListener("popstate", handlePopState);
    void navigate(true);
  });
  onDestroy(() => {
    document.removeEventListener("click", handleClick);
    window.removeEventListener("popstate", handlePopState);
  });
  return {
    transientView,
    statusMessage,
    routeError,
    retryLabel,
    workspaceName,
    creatingWorkspace,
    onboardingError,
    workspaceCreationComplete,
    createdWorkspaceName,
    createdWebhookPath,
    createWorkspace,
    continueToWorkspace,
    retryNavigation,
  };
}
