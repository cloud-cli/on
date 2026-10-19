import { defineProp, onInit, ref } from "@li3/web";

export default function () {
  const authConfigured = ref(false);
  const authenticated = ref(false);
  const userRole = ref("");
  const canViewOperations = ref(false);
  const userName = ref("");
  const userPhoto = ref("");
  const teams = ref([]);
  const activeTeamId = ref(localStorage.getItem("runner-team-id") || "");
  const switchTeam = (event) => {
    const teamId = event.target.value;
    if (teamId && teams.value.some((team) => team.id === teamId)) {
      localStorage.setItem("runner-team-id", teamId);
      window.location.reload();
    }
  };
  const loadTeams = async () => {
    const teamResponse = await fetch("/api/v1/workspaces", { headers: { accept: "application/json" } });
    if (!teamResponse.ok) {
      return;
    }
    teams.value = (await teamResponse.json()).workspaces || [];

    if (!teams.value.some((team) => team.id === activeTeamId.value)) {
      activeTeamId.value = teams.value[0]?.id || "";
      if (activeTeamId.value) {
        localStorage.setItem("runner-team-id", activeTeamId.value);
      } else {
        localStorage.removeItem("runner-team-id");
      }
    }
  };
  onInit(async () => {
    try {
      const response = await fetch("/api/v1/auth/session");
      if (!response.ok) {
        return;
      }

      const session = await response.json();
      authConfigured.value = session.configured;
      authenticated.value = session.authenticated;
      userRole.value = session.user?.role || "";
      const capabilities = session.user?.capabilities || [];
      canViewOperations.value = capabilities.some((capability) => capability.startsWith("platform."));
      userName.value = session.user?.name || session.user?.email || "";
      userPhoto.value = session.user?.photo || "";
      await loadTeams();
    } catch {}
  });
  window.addEventListener("runner-teams-updated", () => void loadTeams());
  return {
    title: defineProp("title"),
    subtitle: defineProp("subtitle"),
    back: defineProp("back"),
    backLabel: defineProp("back-label"),
    authConfigured,
    authenticated,
    userRole,
    canViewOperations,
    userName,
    userPhoto,
    teams,
    activeTeamId,
    switchTeam,
  };
}
