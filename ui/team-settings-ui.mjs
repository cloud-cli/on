import { onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";
import { workspaceIdFromPathname } from "@app/workspace-path.mjs";

export default function () {
  const teamId = workspaceIdFromPathname(location.pathname);
  const members = ref([]);
  const groups = ref([]);
  const roles = ref({});
  const roleLabels = ref({});
  const isAdmin = ref(false);
  const canManage = ref(false);
  const teamName = ref("");
  const newTeamName = ref("");
  const inviteEmail = ref("");
  const inviteLink = ref("");
  const webhooks = ref([]);
  const webhookProvider = ref("");
  const webhookUrl = ref("");
  const webhookSecret = ref("");
  const message = ref("");
  const error = ref("");
  const teamRunners = ref([]);
  const sharedRunners = ref([]);
  const availableRunners = ref([]);
  const enrollmentCode = ref("");
  const enrollmentExpiresAt = ref("");
  const secrets = ref([]);
  const secretName = ref("");
  const secretValue = ref("");
  const fileMode = ref(false);
  const secretFileName = ref("");
  const secretFileData = ref("");
  const selectedMember = ref("");
  const permissionRows = ref([]);
  const draftRole = ref("collaborator");
  const draftOverrides = ref([]);
  const savingPermissions = ref(false);
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
    const result = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }
    return result;
  };
  const workspaceUrl = (suffix = "") => `/api/v1/workspaces/${encodeURIComponent(teamId)}${suffix}`;
  const load = async () => {
    const permissions = await request(workspaceUrl("/permissions"));
    members.value = permissions.members || [];
    groups.value = permissions.groups || [];
    roles.value = permissions.roles || {};
    roleLabels.value = permissions.roleLabels || {};
    canManage.value = Boolean(permissions.canManage);
    const { webhooks: registrations = [] } = await request(workspaceUrl("/webhooks"));
    webhooks.value = registrations;
    const runners = await request(`/api/v1/teams/${encodeURIComponent(teamId)}/runners`);
    teamRunners.value = runners.team || [];
    sharedRunners.value = runners.shared || [];
    availableRunners.value = runners.available || [];
    secrets.value = (await request("/api/v1/secrets")).secrets || [];
    if (selectedMember.value && !members.value.some((member) => member.subject === selectedMember.value)) {
      selectedMember.value = "";
    }
    if (selectedMember.value) {
      editMember(selectedMember.value);
    }
  };
  const roleCapabilities = (role) => new Set(roles.value[role] || []);
  const buildRows = () => {
    const base = roleCapabilities(draftRole.value);
    const overrides = new Map(draftOverrides.value.map((entry) => [entry.capability, entry.effect]));
    const presetFor = (role, capability) => roleCapabilities(role).has(capability);
    const rows = [];
    for (const group of groups.value || []) {
      rows.push({ kind: "group", id: group.id, label: group.label, description: group.description });
      for (const entry of group.capabilities) {
        const override = overrides.get(entry.capability);
        const effective = override ? override === "allow" : base.has(entry.capability);
        rows.push({
          kind: "capability",
          capability: entry.capability,
          label: entry.label,
          description: entry.description,
          checked: effective,
          overridden: Boolean(override),
          overrideLabel: override === "allow" ? "granted" : override === "deny" ? "denied" : "",
          viewer: presetFor("viewer", entry.capability),
          collaborator: presetFor("collaborator", entry.capability),
          admin: presetFor("admin", entry.capability),
        });
      }
    }
    permissionRows.value = rows;
  };
  const editMember = (subject) => {
    const member = members.value.find((entry) => entry.subject === subject);
    selectedMember.value = member?.subject || "";
    draftRole.value = member?.role || "collaborator";
    draftOverrides.value = [...(member?.overrides || [])];
    buildRows();
  };
  const setDraftRole = (event) => {
    draftRole.value = event.target.value;
    buildRows();
  };
  const toggleCapability = (capability) => {
    const base = roleCapabilities(draftRole.value);
    const overrides = new Map(draftOverrides.value.map((entry) => [entry.capability, entry.effect]));
    const current = overrides.has(capability.capability)
      ? overrides.get(capability.capability) === "allow"
      : base.has(capability.capability);
    const next = !current;
    if (next === base.has(capability.capability)) {
      overrides.delete(capability.capability);
    } else {
      overrides.set(capability.capability, next ? "allow" : "deny");
    }
    draftOverrides.value = [...overrides].map(([name, effect]) => ({ capability: name, effect }));
    buildRows();
  };
  const savePermissions = () =>
    act(async () => {
      if (!selectedMember.value) {
        return;
      }
      savingPermissions.value = true;
      try {
        await request(workspaceUrl(`/members/${encodeURIComponent(selectedMember.value)}`), {
          method: "PUT",
          body: JSON.stringify({ role: draftRole.value, overrides: draftOverrides.value }),
        });
        await load();
        message.value = "Permissions saved.";
      } finally {
        savingPermissions.value = false;
      }
    });
  const setFileMode = (event) => {
    fileMode.value = event.target.checked;
  };
  const setInviteEmail = (event) => {
    inviteEmail.value = event.target.value;
  };
  const setWebhookProvider = (event) => {
    webhookProvider.value = event.target.value;
  };
  const setSecretName = (event) => {
    secretName.value = event.target.value;
  };
  const setSecretValue = (event) => {
    secretValue.value = event.target.value;
  };
  const setNewTeamName = (event) => {
    newTeamName.value = event.target.value;
  };
  const setTokenName = (event) => {
    tokenName.value = event.target.value;
  };
  const setAgentName = (event) => {
    agentName.value = event.target.value;
  };
  const setTokenSubject = (event) => {
    tokenSubject.value = event.target.value;
  };
  const setSecretFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    secretFileName.value = file.name;
    secretFileData.value = btoa(binary);
  };
  const saveSecret = () =>
    act(async () => {
      const name = secretName.value.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
        throw new Error("Secret names must start with a letter and contain only letters, numbers, and underscores.");
      }
      if (fileMode.value ? !secretFileData.value : !secretValue.value) {
        throw new Error(fileMode.value ? "Choose a file first." : "Set a secret value first.");
      }
      await request(`/api/v1/secrets/${encodeURIComponent(name)}`, {
        method: "PUT",
        body: JSON.stringify(
          fileMode.value
            ? { value: secretFileData.value, encoding: "base64", originalName: secretFileName.value }
            : { value: secretValue.value, encoding: "utf8" },
        ),
      });
      secretName.value = "";
      secretValue.value = "";
      secretFileName.value = "";
      secretFileData.value = "";
      fileMode.value = false;
      await load();
      message.value = `Saved ${name}.`;
    });
  const deleteSecret = (secret) =>
    act(async () => {
      if (!confirm(`Delete secret ${secret}?`)) {
        return;
      }
      await request(`/api/v1/secrets/${encodeURIComponent(secret)}`, { method: "DELETE" });
      await load();
      message.value = `Deleted ${secret}.`;
    });
  const act = async (action) => {
    error.value = "";
    try {
      await action();
    } catch (reason) {
      error.value = reason.message;
    }
  };
  const renameWorkspace = () =>
    act(async () => {
      const name = newTeamName.value.trim();
      if (!name) {
        throw new Error("Enter a workspace name.");
      }
      const result = await request(workspaceUrl(), {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
      teamName.value = result.workspace?.name || name;
      newTeamName.value = "";
      message.value = "Workspace renamed.";
      window.dispatchEvent(new Event("runner-teams-updated"));
    });
  const deleteWorkspace = () =>
    act(async () => {
      const typed = window.prompt(
        `This permanently deletes ${teamName.value}, including every workflow, run, log, artifact, secret, and runner. Type the workspace name to confirm.`,
      );
      if (typed === null) {
        return;
      }
      if (typed.trim() !== teamName.value) {
        throw new Error("The workspace name did not match. Nothing was deleted.");
      }
      await request(workspaceUrl(), { method: "DELETE" });
      window.location.assign("/ui/runs");
    });
  const createInvitation = () =>
    act(async () => {
      const result = await request(workspaceUrl("/invitations"), {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.value }),
      });
      inviteLink.value = new URL(result.link, location.origin).toString();
      message.value = `Invite link expires ${new Date(result.expiresAt).toLocaleString()}.`;
    });
  const createWebhook = () =>
    act(async () => {
      const provider = webhookProvider.value.trim();
      if (!/^[a-z0-9-]+$/.test(provider)) {
        throw new Error("Webhook URL slugs must contain only lowercase letters, numbers, and hyphens.");
      }
      const result = await request(workspaceUrl("/webhooks"), {
        method: "POST",
        body: JSON.stringify({ provider }),
      });
      webhookUrl.value = `${location.origin}${result.url}`;
      webhookSecret.value = result.signingSecret;
      message.value = "Webhook created. Copy the URL and signing secret now; the secret is only shown once.";
      await load();
    });
  const revokeWebhook = (registration) =>
    act(async () => {
      if (!confirm(`Revoke this ${registration.provider} webhook? Its URL and signing secret will stop working.`)) {
        return;
      }
      await request(workspaceUrl(`/webhooks/${encodeURIComponent(registration.id)}`), { method: "DELETE" });
      await load();
      message.value = "Webhook revoked.";
    });
  const copyValue = async (value) => {
    await navigator.clipboard.writeText(value);
    message.value = "Copied to clipboard.";
  };
  const createRunnerEnrollment = () =>
    act(async () => {
      const result = await request("/api/v1/runner-enrollments", {
        method: "POST",
        body: JSON.stringify({ scope: "team", teamId }),
      });
      enrollmentCode.value = result.code;
      enrollmentExpiresAt.value = result.expiresAt;
      message.value = "Enrollment code created. It can be used once.";
    });
  const setSharedRunner = (runner, active) =>
    act(async () => {
      if (
        !active &&
        !confirm(
          `Deactivate ${runner.name} for this team? Its current team jobs will be canceled and retried after the lease expires.`,
        )
      ) {
        return;
      }
      await request(`/api/v1/teams/${encodeURIComponent(teamId)}/runners/${encodeURIComponent(runner.id)}`, {
        method: active ? "POST" : "DELETE",
      });
      await load();
    });
  const removeMember = (member) =>
    act(async () => {
      if (!confirm(`Remove ${member.name || "Unnamed member"} from this workspace?`)) {
        return;
      }
      await request(workspaceUrl(`/members/${encodeURIComponent(member.subject)}`), { method: "DELETE" });
      if (selectedMember.value === member.subject) {
        selectedMember.value = "";
        permissionRows.value = [];
      }
      await load();
    });
  onInit(async () => {
    try {
      const { workspaces = [] } = await request("/api/v1/workspaces");
      const team = workspaces.find((item) => item.id === teamId);
      if (!team) {
        throw new Error("You are not a member of this workspace.");
      }

      teamName.value = team.name;
      isAdmin.value = team.role === "admin";
      await load();
    } catch (reason) {
      error.value = reason.message;
      document.querySelector("#team-settings")?.remove();
    }
  });
  return {
    teamId,
    teamName,
    newTeamName,
    setNewTeamName,
    renameWorkspace,
    deleteWorkspace,
    members,
    groups,
    roles,
    roleLabels,
    isAdmin,
    canManage,
    inviteEmail,
    inviteLink,
    webhooks,
    webhookProvider,
    webhookUrl,
    webhookSecret,
    message,
    error,
    createInvitation,
    setInviteEmail,
    createWebhook,
    setWebhookProvider,
    revokeWebhook,
    copyValue,
    removeMember,
    teamRunners,
    sharedRunners,
    availableRunners,
    enrollmentCode,
    enrollmentExpiresAt,
    createRunnerEnrollment,
    setSharedRunner,
    secrets,
    secretName,
    setSecretName,
    secretValue,
    setSecretValue,
    fileMode,
    setFileMode,
    secretFileName,
    setSecretFile,
    saveSecret,
    deleteSecret,
    selectedMember,
    permissionRows,
    draftRole,
    editMember,
    setDraftRole,
    toggleCapability,
    savePermissions,
    savingPermissions,
  };
}
