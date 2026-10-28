import { onDestroy, onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";
import { applyThemePreference, getAuthPreference, setAuthPreference } from "@app/preferences.mjs";

export default function setup() {
  const activeSection = ref("workspaces");
  const user = ref({ name: "", email: "", role: "" });
  const oidcProviderUrl = ref("");
  const userAuthenticated = ref(false);
  const userInitial = ref("U");
  const teams = ref([]);
  const selectedWorkspaceId = ref("");
  const selectedChannelId = ref("");
  const workspaceChannels = ref([]);
  const channelsStatus = ref("Loading channels…");
  const channelsEmpty = ref(false);
  let channelsRequestId = 0;
  let lastSyncedPath = "";
  const quickSwitchOpen = ref(false);
  const workspaceRailExpanded = ref(false);
  const navigationOpen = ref(false);
  const desktopNavigationMedia = window.matchMedia("(min-width: 768px)");
  const quickSwitchItems = ref([]);
  const themePreference = ref("system");
  const setSelectedWorkspace = (workspaceId) => {
    selectedWorkspaceId.value = workspaceId;
    teams.value = teams.value.map((team) => ({
      ...team,
      isSelected: team.id === workspaceId,
    }));
  };
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const isDarkTheme = ref(
    document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && themeMedia.matches),
  );
  const loadTeams = async () => {
    const hadSelectedWorkspace = Boolean(selectedWorkspaceId.value);
    try {
      const response = await fetch("/api/v1/workspaces", {
        headers: { accept: "application/json" },
      });
      const availableTeams = response.ok ? (await response.json()).workspaces || [] : [];
      if (!selectedWorkspaceId.value) {
        const storedWorkspaceId = localStorage.getItem("runner-team-id") || "";
        selectedWorkspaceId.value = availableTeams.some((team) => team.id === storedWorkspaceId)
          ? storedWorkspaceId
          : "";
      }
      teams.value = availableTeams.map((team) => ({
        ...team,
        isSelected: team.id === selectedWorkspaceId.value,
      }));
      if (!hadSelectedWorkspace && selectedWorkspaceId.value) {
        void loadWorkspaceChannels();
      }
    } catch (error) {
      console.error("Unable to load teams", error);
    }
  };

  const handleSkipKeydown = (event) => {
    if (!event.target.closest?.("[data-skip-to-content]") || !["Enter", " "].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const mainContent = document.getElementById("main-content");
    mainContent?.focus({ preventScroll: true });
    mainContent?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const syncSection = () => {
    const path = window.location.pathname.replace(/^\/ui/, "").replace(/\/+$/, "") || "/";
    if (path === lastSyncedPath) {
      return;
    }
    const firstSync = lastSyncedPath === "";
    lastSyncedPath = path;
    const previousWorkspaceId = selectedWorkspaceId.value;
    const workspaceRoute = path.match(/^\/workspaces\/([^/]+)\/(workflows|runs|channels)(?:\/([^/]+))?(?:\/events)?$/);
    if (workspaceRoute) {
      setSelectedWorkspace(decodeURIComponent(workspaceRoute[1]));
      selectedChannelId.value = workspaceRoute[2] === "channels" ? decodeURIComponent(workspaceRoute[3] || "") : "";
      activeSection.value = `workspace-${workspaceRoute[2] === "channels" ? "channels" : workspaceRoute[2] === "workflows" ? "workflows" : "runs"}`;
    } else if (
      path === "/settings" ||
      path.startsWith("/settings") ||
      (path.startsWith("/teams/") && path.endsWith("/settings")) ||
      (path.startsWith("/workspaces/") && path.endsWith("/settings"))
    ) {
      activeSection.value = "settings";
    } else if (path.startsWith("/recipes")) {
      activeSection.value = "recipes";
    } else {
      activeSection.value = "workspaces";
    }
    if (selectedWorkspaceId.value !== previousWorkspaceId || (firstSync && !selectedWorkspaceId.value)) {
      void loadWorkspaceChannels();
    }
  };

  const loadWorkspaceChannels = async () => {
    const requestId = ++channelsRequestId;
    const workspaceId = selectedWorkspaceId.value;
    workspaceChannels.value = [];
    channelsEmpty.value = false;
    if (!workspaceId) {
      channelsStatus.value = "Select a workspace to view its Streams.";
      return;
    }
    channelsStatus.value = "Loading Streams…";
    try {
      const response = await apiFetch("/api/v1/streams", {
        headers: { accept: "application/json", "X-Team-ID": workspaceId },
      });
      if (!response.ok) {
        throw new Error(`Unable to load Streams (${response.status}).`);
      }
      const result = await response.json();
      if (requestId !== channelsRequestId || workspaceId !== selectedWorkspaceId.value) {
        return;
      }
      workspaceChannels.value = result.streams || [];
      channelsEmpty.value = workspaceChannels.value.length === 0;
      channelsStatus.value = "";
    } catch (error) {
      if (requestId === channelsRequestId) {
        channelsStatus.value = error.message || "Unable to load Streams.";
      }
    }
  };

  const setActive = (section) => {
    activeSection.value = section;
    closeNavigation();
  };
  const openNavigation = () => {
    navigationOpen.value = true;
    document.querySelector("[data-app-layout]")?.classList.add("navigation-open");
    document.querySelector("[data-nav-open]")?.setAttribute("aria-expanded", "true");
    document.querySelector("[data-workspace-rail]")?.setAttribute("inert", "");
    document.querySelector(".col-start-1.row-start-2")?.setAttribute("inert", "");
    document.querySelector("[data-skip-to-content]")?.setAttribute("inert", "");
    requestAnimationFrame(() => document.querySelector("[data-nav-close]")?.focus());
  };
  const closeNavigation = (restoreFocus = true) => {
    navigationOpen.value = false;
    document.querySelector("[data-app-layout]")?.classList.remove("navigation-open");
    document.querySelector("[data-nav-open]")?.setAttribute("aria-expanded", "false");
    document.querySelector("[data-workspace-rail]")?.removeAttribute("inert");
    document.querySelector(".col-start-1.row-start-2")?.removeAttribute("inert");
    document.querySelector("[data-skip-to-content]")?.removeAttribute("inert");
    if (restoreFocus) {
      document.querySelector("[data-nav-open]")?.focus();
    }
  };
  const closeNavigationOnDesktop = () => {
    if (desktopNavigationMedia.matches && navigationOpen.value) {
      closeNavigation(false);
    }
  };
  const handleNavigationKeys = (event) => {
    if (event.key === "Escape" && navigationOpen.value) {
      event.preventDefault();
      closeNavigation();
    } else if (event.key === "Tab" && navigationOpen.value) {
      const focusable = [
        ...document.querySelectorAll("#primary-sidebar a[href], #primary-sidebar button:not([disabled])"),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };
  const handleNavigationClick = (event) => {
    if (event.target.closest?.("[data-nav-open], [data-nav-close]")) {
      return;
    }
    if (event.target.closest?.("#primary-sidebar a")) {
      closeNavigation();
    } else if (
      navigationOpen.value &&
      event.target.closest?.("[data-app-layout]") &&
      !event.target.closest?.("#primary-sidebar")
    ) {
      closeNavigation();
    }
  };
  const toggleWorkspaceRail = () => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      openNavigation();
      return;
    }
    workspaceRailExpanded.value = !workspaceRailExpanded.value;
    document.querySelector("[data-workspace-rail]")?.classList.toggle("is-expanded", workspaceRailExpanded.value);
  };
  const selectWorkspace = (teamId, page = "runs") => {
    setSelectedWorkspace(teamId);
    activeSection.value = `workspace-${page === "channels" ? "channels" : page === "workflows" ? "workflows" : "runs"}`;
    void loadWorkspaceChannels();
  };
  const workspaceInitial = (name) =>
    String(name || "W")
      .trim()
      .slice(0, 1)
      .toUpperCase();
  let activeWorkspacePopover;
  const showWorkspacePopover = (_name, button) => {
    const popover = button?.nextElementSibling;
    if (!popover?.hasAttribute("data-workspace-popover")) {
      return;
    }
    if (
      activeWorkspacePopover &&
      activeWorkspacePopover !== popover &&
      activeWorkspacePopover.matches(":popover-open")
    ) {
      activeWorkspacePopover.hidePopover();
    }
    const rect = button.getBoundingClientRect();
    if (!popover.matches(":popover-open")) {
      popover.showPopover();
    }
    popover.style.left = `${rect.right + 8}px`;
    popover.style.top = `${rect.top + (rect.height - popover.offsetHeight) / 2}px`;
    activeWorkspacePopover = popover;
  };
  const hideWorkspacePopover = (button) => {
    if (button?.matches(":hover, :focus")) {
      return;
    }
    const popover = button?.nextElementSibling;
    if (popover?.matches(":popover-open")) {
      popover.hidePopover();
    }
    if (activeWorkspacePopover === popover) {
      activeWorkspacePopover = null;
    }
  };
  const navigateShell = (path) => {
    history.pushState(null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const switchWorkspace = (teamId) => {
    const page =
      activeSection.value === "workspace-channels"
        ? "channels"
        : activeSection.value === "workspace-workflows"
          ? "workflows"
          : "runs";
    navigateShell(workspacePath(teamId, page));
  };
  const filterQuickSwitch = (query = "") => {
    const normalized = query.trim().toLocaleLowerCase();
    const items = [];
    for (const team of teams.value) {
      items.push({
        label: team.name,
        type: "Workspace",
        path: workspacePath(team.id, "runs"),
      });
      for (const [label, page] of [
        ["Streams", "channels"],
        ["Runs", "runs"],
        ["Workflows", "workflows"],
      ]) {
        items.push({
          label: `${team.name} · ${label}`,
          type: label === "channels" ? "Stream" : label,
          path: workspacePath(team.id, page),
        });
      }
    }
    items.push(
      { label: "Recipes", type: "Route", path: "/ui/recipes" },
      { label: "Settings", type: "Route", path: "/ui/settings" },
      { label: "Workspaces", type: "Route", path: "/ui/workspaces" },
    );
    quickSwitchItems.value = items
      .filter((item) => `${item.label} ${item.type}`.toLocaleLowerCase().includes(normalized))
      .map((item, index) => ({ ...item, index }));
  };
  const openQuickSwitch = () => {
    quickSwitchOpen.value = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!quickSwitchOpen.value) {
          return;
        }
        filterQuickSwitch();
        document.querySelector("[data-quick-switch-search]")?.focus();
      });
    });
  };
  const closeQuickSwitch = () => {
    if (!quickSwitchOpen.value) {
      return;
    }
    quickSwitchOpen.value = false;
    requestAnimationFrame(() => document.querySelector("[data-quick-switch-open]")?.focus());
  };
  const selectQuickSwitchItem = (item) => {
    closeQuickSwitch();
    navigateShell(item.path);
  };
  const stopQuickSwitchClick = (event) => event.stopPropagation();
  const handleGlobalQuickSwitch = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openQuickSwitch();
    } else if (event.key === "Escape" && quickSwitchOpen.value) {
      event.preventDefault();
      closeQuickSwitch();
    } else if (quickSwitchOpen.value && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const options = [...document.querySelectorAll("[data-quick-switch-results] button")];
      if (!options.length) {
        return;
      }
      const index = options.indexOf(document.activeElement);
      if (index < 0) {
        options[event.key === "ArrowDown" ? 0 : options.length - 1].focus();
      } else {
        options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].focus();
      }
    } else if (
      quickSwitchOpen.value &&
      event.key === "Enter" &&
      event.target.matches?.("[data-quick-switch-search]") &&
      quickSwitchItems.value[0]
    ) {
      event.preventDefault();
      closeQuickSwitch();
      navigateShell(quickSwitchItems.value[0].path);
    } else if (quickSwitchOpen.value && event.key === "Tab") {
      const search = document.querySelector("[data-quick-switch-search]");
      const focusable = [search, ...document.querySelectorAll("[data-quick-switch-results] button")].filter(Boolean);
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault();
        focusable.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
        event.preventDefault();
        focusable[0]?.focus();
      }
    }
  };
  const workspacePath = (teamId, page) =>
    `/ui/workspaces/${encodeURIComponent(teamId || selectedWorkspaceId.value)}/${page}`;
  const openPreferences = () => {
    history.pushState(null, "", "/ui/settings");
    window.dispatchEvent(new PopStateEvent("popstate"));
  };
  const syncSystemTheme = () => {
    if (themePreference.value === "system") {
      isDarkTheme.value = themeMedia.matches;
    }
  };
  const toggleTheme = async () => {
    const nextTheme = isDarkTheme.value ? "light" : "dark";
    try {
      await setAuthPreference("theme", nextTheme);
      themePreference.value = nextTheme;
      isDarkTheme.value = nextTheme === "dark";
      applyThemePreference(nextTheme);
    } catch (error) {
      console.error("Unable to save appearance preference", error);
    }
  };
  const syncWorkspace = () => syncSection();

  onInit(() => {
    void getAuthPreference("theme")
      .then((theme) => {
        themePreference.value = ["light", "dark", "system"].includes(theme) ? theme : "system";
        applyThemePreference(themePreference.value);
        syncSystemTheme();
      })
      .catch((error) => {
        syncSystemTheme();
        console.error("Unable to load appearance preference", error);
      });
    themeMedia.addEventListener("change", syncSystemTheme);
    syncSection();
    window.addEventListener("popstate", syncSection);
    window.addEventListener("runner-route-changed", syncSection);
    window.addEventListener("runner-team-changed", syncWorkspace);
    document.addEventListener("keydown", handleSkipKeydown);
    document.addEventListener("keydown", handleNavigationKeys);
    document.addEventListener("click", handleNavigationClick);
    desktopNavigationMedia.addEventListener("change", closeNavigationOnDesktop);
    document.addEventListener("keydown", handleGlobalQuickSwitch);
    void fetch("/api/v1/auth/session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((session) => {
        if (!session?.authenticated || !session.user) {
          return;
        }
        user.value = session.user;
        oidcProviderUrl.value = session.providerUrl || "";
        userAuthenticated.value = true;
        userInitial.value = String(session.user.name || session.user.email || "U")
          .trim()
          .slice(0, 1)
          .toUpperCase();
        void loadTeams();
      })
      .catch((error) => console.error("Unable to load the signed-in profile", error));
    window.addEventListener("runner-teams-updated", loadTeams);
    window.addEventListener("runner-channels-updated", loadWorkspaceChannels);
  });

  onDestroy(() => {
    window.removeEventListener("popstate", syncSection);
    window.removeEventListener("runner-route-changed", syncSection);
    window.removeEventListener("runner-team-changed", syncWorkspace);
    window.removeEventListener("runner-teams-updated", loadTeams);
    window.removeEventListener("runner-channels-updated", loadWorkspaceChannels);
    themeMedia.removeEventListener("change", syncSystemTheme);
    document.removeEventListener("keydown", handleSkipKeydown);
    document.removeEventListener("keydown", handleNavigationKeys);
    document.removeEventListener("click", handleNavigationClick);
    desktopNavigationMedia.removeEventListener("change", closeNavigationOnDesktop);
    document.removeEventListener("keydown", handleGlobalQuickSwitch);
  });

  return {
    activeSection,
    user,
    userAuthenticated,
    userInitial,
    oidcProviderUrl,
    teams,
    selectedWorkspaceId,
    selectedChannelId,
    workspaceChannels,
    channelsStatus,
    channelsEmpty,
    isDarkTheme,
    setActive,
    workspaceRailExpanded,
    toggleWorkspaceRail,
    navigationOpen,
    openNavigation,
    closeNavigation,
    selectWorkspace,
    switchWorkspace,
    workspaceInitial,
    showWorkspacePopover,
    hideWorkspacePopover,
    quickSwitchOpen,
    quickSwitchItems,
    openQuickSwitch,
    closeQuickSwitch,
    filterQuickSwitch,
    selectQuickSwitchItem,
    stopQuickSwitchClick,
    workspacePath,
    openPreferences,
    toggleTheme,
  };
}
