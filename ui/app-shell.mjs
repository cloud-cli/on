import { onDestroy, onInit, ref } from "@li3/web";
import "@app/api-client.mjs";
import { applyThemePreference, getAuthPreference, setAuthPreference } from "@app/preferences.mjs";

export default function setup() {
  const activeSection = ref("workspaces");
  const mobileMenuOpen = ref(false);
  const user = ref({ name: "", email: "", role: "" });
  const oidcProviderUrl = ref("");
  const userAuthenticated = ref(false);
  const userInitial = ref("U");
  const teams = ref([]);
  const selectedWorkspaceId = ref("");
  const quickSwitchOpen = ref(false);
  const quickSwitchItems = ref([]);
  const themePreference = ref("system");
  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const isDarkTheme = ref(
    document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && themeMedia.matches),
  );
  const loadTeams = async () => {
    try {
      const response = await fetch("/api/v1/workspaces", { headers: { accept: "application/json" } });
      teams.value = response.ok ? (await response.json()).workspaces || [] : [];
      if (!selectedWorkspaceId.value) {
        const storedWorkspaceId = localStorage.getItem("runner-team-id") || "";
        selectedWorkspaceId.value = teams.value.some((team) => team.id === storedWorkspaceId) ? storedWorkspaceId : "";
      }
      requestAnimationFrame(syncWorkspaceNavigation);
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

  const syncWorkspaceNavigation = () => {
    const selectedId = selectedWorkspaceId.value;
    for (const item of document.querySelectorAll("[data-workspace-nav-item]")) {
      const selected = item.getAttribute("data-workspace-nav-item") === selectedId;
      const submenu = item.querySelector("[data-workspace-submenu]");
      submenu?.classList.toggle("hidden", !selected);
      const [workspaceLink, workflowsLink, runsLink, channelsLink] = item.querySelectorAll("a");
      if (workspaceLink) {
        workspaceLink.setAttribute(
          "aria-current",
          selected && activeSection.value === "workspace-runs" ? "page" : "null",
        );
      }
      if (workflowsLink) {
        workflowsLink.setAttribute(
          "aria-current",
          selected && activeSection.value === "workspace-workflows" ? "page" : "null",
        );
      }
      if (runsLink) {
        runsLink.setAttribute("aria-current", selected && activeSection.value === "workspace-runs" ? "page" : "null");
      }
      if (channelsLink) {
        channelsLink.setAttribute(
          "aria-current",
          selected && activeSection.value === "workspace-channels" ? "page" : "null",
        );
      }
    }
  };
  const syncSection = () => {
    const path = window.location.pathname.replace(/^\/ui/, "");
    const workspaceRoute = path.match(/^\/workspaces\/([^/]+)\/(workflows|runs|channels)(?:\/events)?$/);
    if (workspaceRoute) {
      selectedWorkspaceId.value = decodeURIComponent(workspaceRoute[1]);
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
    syncWorkspaceNavigation();
  };

  const setActive = (section) => {
    activeSection.value = section;
  };
  const selectWorkspace = (teamId, page = "runs") => {
    selectedWorkspaceId.value = teamId;
    activeSection.value = `workspace-${page === "channels" ? "channels" : page === "workflows" ? "workflows" : "runs"}`;
    syncWorkspaceNavigation();
  };
  const workspaceInitial = (name) =>
    String(name || "W")
      .trim()
      .slice(0, 1)
      .toUpperCase();
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
    selectedWorkspaceId.value = teamId;
    syncWorkspaceNavigation();
    navigateShell(workspacePath(teamId, page));
    closeMobileMenu();
  };
  const filterQuickSwitch = (query = "") => {
    const normalized = query.trim().toLocaleLowerCase();
    const items = [];
    for (const team of teams.value) {
      items.push({ label: team.name, type: "Workspace", path: workspacePath(team.id, "runs") });
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
      filterQuickSwitch();
      document.querySelector("[data-quick-switch-search]")?.focus();
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
  const syncMobileMenu = () => {
    const sidebar = document.getElementById("primary-sidebar");
    if (sidebar) {
      sidebar.inert = !mobileMenuOpen.value && window.matchMedia("(max-width: 767px)").matches;
    }
  };
  const toggleMobileMenu = () => {
    mobileMenuOpen.value = !mobileMenuOpen.value;
    syncMobileMenu();
    if (mobileMenuOpen.value) {
      requestAnimationFrame(() => document.querySelector("#primary-sidebar a")?.focus());
    } else {
      document.querySelector("[data-mobile-menu-button]")?.focus();
    }
  };
  const closeMobileMenu = () => {
    if (!mobileMenuOpen.value) {
      return;
    }
    mobileMenuOpen.value = false;
    syncMobileMenu();
    if (window.matchMedia("(max-width: 767px)").matches) {
      requestAnimationFrame(() => document.querySelector("[data-mobile-menu-button]")?.focus());
    }
  };
  const handleMenuKeydown = (event) => {
    if (event.key === "Escape" && mobileMenuOpen.value) {
      event.preventDefault();
      closeMobileMenu();
      document.querySelector("[data-mobile-menu-button]")?.focus();
      return;
    }
    if (event.key === "Tab" && mobileMenuOpen.value) {
      const links = [...(document.getElementById("primary-sidebar")?.querySelectorAll("a") || [])];
      if (!links.length) {
        return;
      }
      if (event.shiftKey && document.activeElement === links[0]) {
        event.preventDefault();
        links.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === links.at(-1)) {
        event.preventDefault();
        links[0].focus();
      }
    }
  };
  const handleMenuClick = (event) => {
    if (event.target.closest?.("#primary-sidebar a")) {
      closeMobileMenu();
    }
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
  const syncWorkspace = (event) => {
    selectedWorkspaceId.value = event.detail?.teamId || "";
    syncWorkspaceNavigation();
  };

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
    syncMobileMenu();
    window.addEventListener("popstate", syncSection);
    window.addEventListener("runner-route-changed", syncSection);
    window.addEventListener("popstate", closeMobileMenu);
    window.addEventListener("resize", syncMobileMenu);
    window.addEventListener("runner-team-changed", syncWorkspace);
    document.addEventListener("keydown", handleSkipKeydown);
    document.addEventListener("keydown", handleGlobalQuickSwitch);
    document.addEventListener("keydown", handleMenuKeydown);
    document.addEventListener("click", handleMenuClick);
    void fetch("/api/v1/auth/session", { credentials: "same-origin", headers: { accept: "application/json" } })
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
  });

  onDestroy(() => {
    window.removeEventListener("popstate", syncSection);
    window.removeEventListener("runner-route-changed", syncSection);
    window.removeEventListener("popstate", closeMobileMenu);
    window.removeEventListener("resize", syncMobileMenu);
    window.removeEventListener("runner-team-changed", syncWorkspace);
    window.removeEventListener("runner-teams-updated", loadTeams);
    themeMedia.removeEventListener("change", syncSystemTheme);
    document.removeEventListener("keydown", handleSkipKeydown);
    document.removeEventListener("keydown", handleGlobalQuickSwitch);
    document.removeEventListener("keydown", handleMenuKeydown);
    document.removeEventListener("click", handleMenuClick);
  });

  return {
    activeSection,
    mobileMenuOpen,
    user,
    userAuthenticated,
    userInitial,
    oidcProviderUrl,
    teams,
    selectedWorkspaceId,
    isDarkTheme,
    setActive,
    selectWorkspace,
    switchWorkspace,
    workspaceInitial,
    quickSwitchOpen,
    quickSwitchItems,
    openQuickSwitch,
    closeQuickSwitch,
    filterQuickSwitch,
    selectQuickSwitchItem,
    stopQuickSwitchClick,
    workspacePath,
    openPreferences,
    toggleMobileMenu,
    closeMobileMenu,
    toggleTheme,
  };
}
