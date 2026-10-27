import { onInit, ref, templateRef } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export default function () {
  const teams = ref([]);
  const newTeamName = ref("");
  const newTeamFormOpen = ref(false);
  const message = ref("");
  const newTeamInput = templateRef("newTeamInput");
  const loadTeams = async () => {
    const response = await apiFetch("/api/v1/workspaces", { headers: { accept: "application/json" } });
    if (response.ok) {
      teams.value = (await response.json()).workspaces || [];
    }
  };
  const createTeam = async (event) => {
    event.preventDefault();
    message.value = "";
    try {
      const response = await apiFetch("/api/v1/workspaces", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ name: newTeamName.value }),
      });
      let result = null;
      try {
        result = await response.json();
      } catch {
        // Authorization layers and proxies may return an empty or non-JSON error body.
      }
      if (!response.ok) {
        throw new Error(result?.error || "Unable to create workspace.");
      }

      if (!result?.workspace?.name) {
        throw new Error("Workspace was created, but its details could not be loaded.");
      }

      newTeamName.value = "";
      newTeamFormOpen.value = false;
      message.value = `Created ${result.workspace.name}.`;
      await loadTeams();
    } catch (error) {
      message.value = error.message;
    }
  };
  const toggleCreateForm = () => {
    newTeamFormOpen.value = !newTeamFormOpen.value;
    message.value = "";
    if (newTeamFormOpen.value) {
      requestAnimationFrame(() => newTeamInput.value?.focus());
    }
  };
  const closeCreateForm = () => {
    newTeamFormOpen.value = false;
    newTeamName.value = "";
    message.value = "";
  };
  onInit(async () => {
    await loadTeams();
  });
  return { teams, newTeamName, newTeamFormOpen, message, createTeam, toggleCreateForm, closeCreateForm };
}
