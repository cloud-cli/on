import { onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export default function () {
  const teamId = decodeURIComponent(location.pathname.split("/")[2] || "");
  const members = ref([]);
  const isAdmin = ref(false);
  const teamName = ref("");
  const newTeamName = ref("");
  const inviteEmail = ref("");
  const inviteLink = ref("");
  const webhookPath = ref("");
  const message = ref("");
  const error = ref("");
  const request = async (url, options = {}) => {
    const response = await apiFetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
        "X-Team-ID": teamId,
      },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
    return result;
  };
  const load = async () => {
    const { members: results = [] } = await request(`/api/teams/${encodeURIComponent(teamId)}/members`);
    members.value = results;
  };
  const act = async (action) => {
    error.value = "";
    try {
      await action();
    } catch (reason) {
      error.value = reason.message;
    }
  };
  const createTeam = () =>
    act(async () => {
      const { team, webhookPath: path } = await request("/api/teams", {
        method: "POST",
        body: JSON.stringify({ name: newTeamName.value }),
      });
      newTeamName.value = "";
      webhookPath.value = `${location.origin}${path}`;
      message.value = `Created ${team.name}. Save the webhook URL now.`;
      window.dispatchEvent(new Event("runner-teams-updated"));
    });
  const createInvitation = () =>
    act(async () => {
      const result = await request(`/api/teams/${encodeURIComponent(teamId)}/invitations`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.value }),
      });
      inviteLink.value = new URL(result.link, location.origin).toString();
      message.value = `Invite link expires ${new Date(result.expiresAt).toLocaleString()}.`;
    });
  const rotateWebhook = () =>
    act(async () => {
      const result = await request(`/api/teams/${encodeURIComponent(teamId)}/webhook-token`, { method: "POST" });
      webhookPath.value = `${location.origin}${result.webhookPath}`;
      message.value = "Webhook URL rotated. Save this URL now.";
    });
  const copyValue = async (value) => {
    await navigator.clipboard.writeText(value);
    message.value = "Copied to clipboard.";
  };
  const toggleMemberRole = (member) =>
    act(async () => {
      const role = member.role === "admin" ? "member" : "admin";
      await request(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(member.subject)}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
      await load();
    });
  const removeMember = (member) =>
    act(async () => {
      await request(`/api/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(member.subject)}`, {
        method: "DELETE",
      });
      await load();
    });
  onInit(async () => {
    try {
      const { teams = [] } = await request("/api/teams");
      const team = teams.find((item) => item.id === teamId);
      if (!team) throw new Error("You are not a member of this team.");
      teamName.value = team.name;
      isAdmin.value = team.role === "admin";
      await load();
    } catch (reason) {
      error.value = reason.message;
      document.querySelector("#team-settings")?.remove();
    }
  });
  return {
    teamName,
    members,
    isAdmin,
    newTeamName,
    inviteEmail,
    inviteLink,
    webhookPath,
    message,
    error,
    createTeam,
    createInvitation,
    rotateWebhook,
    copyValue,
    toggleMemberRole,
    removeMember,
  };
}
