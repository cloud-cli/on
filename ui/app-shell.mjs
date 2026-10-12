import { onDestroy, onInit, ref } from "@li3/web";
import "@app/api-client.mjs";
import { applyThemePreference, getAuthPreference } from "@app/preferences.mjs";

export default function setup() {
  const activeSection = ref("workspaces");
  const user = ref({ name: "", email: "", role: "" });
  const oidcProviderUrl = ref("");
  const userAuthenticated = ref(false);
  const userInitial = ref("U");
  const teams = ref([]);
  const selectedWorkspaceId = ref(localStorage.getItem("runner-team-id") || "");
  const loadTeams = async () => {
    try {
      const response = await fetch("/api/v1/workspaces", { headers: { accept: "application/json" } });
      teams.value = response.ok ? (await response.json()).workspaces || [] : [];
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
    const path = window.location.pathname;
    const workspaceRuns = path.match(/^\/workspaces\/([^/]+)\/runs$/);
    if (workspaceRuns) {
      activeSection.value = "workspace-runs";
      selectedWorkspaceId.value = decodeURIComponent(workspaceRuns[1]);
    } else if (
      path.startsWith("/settings") ||
      (path.startsWith("/teams/") && path.endsWith("/settings")) ||
      (path.startsWith("/workspaces/") && path.endsWith("/settings"))
    ) {
      activeSection.value = "settings";
    } else if (path.startsWith("/workflows")) {
      activeSection.value = "workflows";
    } else {
      activeSection.value = "workspaces";
    }
  };

  const setActive = (section) => {
    activeSection.value = section;
  };
  const selectWorkspace = (teamId) => {
    selectedWorkspaceId.value = teamId;
    activeSection.value = "workspace-runs";
  };
  const syncWorkspace = (event) => {
    selectedWorkspaceId.value = event.detail?.teamId || localStorage.getItem("runner-team-id") || "";
  };

  onInit(() => {
    void getAuthPreference("theme")
      .then((theme) => {
        applyThemePreference(theme);
      })
      .catch((error) => console.error("Unable to load appearance preference", error));
    syncSection();
    window.addEventListener("popstate", syncSection);
    window.addEventListener("runner-team-changed", syncWorkspace);
    document.addEventListener("keydown", handleSkipKeydown);
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
    window.removeEventListener("runner-team-changed", syncWorkspace);
    window.removeEventListener("runner-teams-updated", loadTeams);
    document.removeEventListener("keydown", handleSkipKeydown);
  });

  return {
    activeSection,
    user,
    userAuthenticated,
    userInitial,
    oidcProviderUrl,
    teams,
    selectedWorkspaceId,
    setActive,
    selectWorkspace,
  };
}
