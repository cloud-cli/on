import { defineProp, onInit, ref } from "@li3/web";

export default function () {
  const authConfigured = ref(false);
  const authenticated = ref(false);
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
    const teamResponse = await fetch("/api/teams", { headers: { accept: "application/json" } });
    if (!teamResponse.ok) return;
    teams.value = (await teamResponse.json()).teams || [];
    if (!teams.value.some((team) => team.id === activeTeamId.value)) {
      activeTeamId.value = teams.value[0]?.id || "";
      if (activeTeamId.value) localStorage.setItem("runner-team-id", activeTeamId.value);
      else localStorage.removeItem("runner-team-id");
    }
  };
  onInit(async () => {
    window.addEventListener("runner-teams-updated", () => void loadTeams());
    try {
      const response = await fetch("/api/auth/session");
      if (!response.ok) return;
      const session = await response.json();
      authConfigured.value = session.configured;
      authenticated.value = session.authenticated;
      userName.value = session.user?.name || session.user?.email || "";
      userPhoto.value = session.user?.photo || "";
      await loadTeams();
    } catch {}
  });
  return {
    title: defineProp("title"),
    subtitle: defineProp("subtitle"),
    back: defineProp("back"),
    backLabel: defineProp("back-label"),
    authConfigured,
    authenticated,
    userName,
    userPhoto,
    teams,
    activeTeamId,
    switchTeam,
  };
}
