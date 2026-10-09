import { onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export default function () {
  const teams = ref([]);
  const newTeamName = ref("");
  const message = ref("");
  const loadTeams = async () => {
    const response = await apiFetch("/api/teams", { headers: { accept: "application/json" } });
    if (response.ok) teams.value = (await response.json()).teams || [];
  };
  const createTeam = async (event) => {
    event.preventDefault();
    message.value = "";
    try {
      const response = await apiFetch("/api/teams", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ name: newTeamName.value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Unable to create team.");
      newTeamName.value = "";
      message.value = `Created ${result.team.name}.`;
      await loadTeams();
    } catch (error) {
      message.value = error.message;
    }
  };
  onInit(async () => {
    await loadTeams();
  });
  return { teams, newTeamName, message, createTeam };
}
