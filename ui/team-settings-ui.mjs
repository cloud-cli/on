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
  const keys = ref([]);
  const keyName = ref("");
  const keyToken = ref("");
  const scopeOptions = ref([
    { name: "workflows:read", label: "Read workflows", selected: true },
    { name: "workflows:write", label: "Modify workflows", selected: false },
    { name: "logs:read", label: "Read logs", selected: false },
    { name: "artifacts:read", label: "Read artifacts", selected: false },
    { name: "runs:control", label: "Control runs", selected: false },
    { name: "runs:dispatch", label: "Dispatch runs", selected: false },
    { name: "workers:read", label: "Read workers", selected: false },
    { name: "secrets:read", label: "Read secret names", selected: false },
    { name: "secrets:write", label: "Manage secrets", selected: false },
  ]);
  const secrets = ref([]);
  const secretName = ref("");
  const secretValue = ref("");
  const fileMode = ref(false);
  const secretFileName = ref("");
  const secretFileData = ref("");
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
    if (!response.ok) {
      throw new Error(result.error || `Request failed (${response.status})`);
    }
    return result;
  };
  const load = async () => {
    const { members: results = [] } = await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/members`);
    members.value = results;
    const { webhooks: registrations = [] } = await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/webhooks`);
    webhooks.value = registrations;
    const runners = await request(`/api/v1/teams/${encodeURIComponent(teamId)}/runners`);
    teamRunners.value = runners.team || [];
    sharedRunners.value = runners.shared || [];
    availableRunners.value = runners.available || [];
    keys.value = isAdmin.value
      ? (await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/api-keys`)).keys || []
      : [];
    secrets.value = (await request("/api/v1/secrets")).secrets || [];
  };
  const issueKey = () =>
    act(async () => {
      const result = await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/api-keys`, {
        method: "POST",
        body: JSON.stringify({
          name: keyName.value,
          scopes: scopeOptions.value.filter((scope) => scope.selected).map((scope) => scope.name),
        }),
      });
      keyToken.value = result.token;
      keyName.value = "";
      await load();
    });
  const revokeKey = (key) =>
    act(async () => {
      if (!confirm(`Revoke ${key.name}? Any automation using it will stop working.`)) {
        return;
      }
      await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/api-keys/${encodeURIComponent(key.id)}`, {
        method: "DELETE",
      });
      await load();
    });
  const setScope = (scope, event) => {
    scope.selected = event.target.checked;
  };
  const setFileMode = (event) => {
    fileMode.value = event.target.checked;
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
  const createInvitation = () =>
    act(async () => {
      const result = await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/invitations`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.value }),
      });
      inviteLink.value = new URL(result.link, location.origin).toString();
      message.value = `Invite link expires ${new Date(result.expiresAt).toLocaleString()}.`;
    });
  const createWebhook = () =>
    act(async () => {
      const result = await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/webhooks`, {
        method: "POST",
        body: JSON.stringify({ provider: webhookProvider.value }),
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
      await request(
        `/api/v1/workspaces/${encodeURIComponent(teamId)}/webhooks/${encodeURIComponent(registration.id)}`,
        {
          method: "DELETE",
        },
      );
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
  const toggleMemberRole = (member) =>
    act(async () => {
      const role = member.role === "admin" ? "member" : "admin";
      await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/members/${encodeURIComponent(member.subject)}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
      await load();
    });
  const removeMember = (member) =>
    act(async () => {
      await request(`/api/v1/workspaces/${encodeURIComponent(teamId)}/members/${encodeURIComponent(member.subject)}`, {
        method: "DELETE",
      });
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
    teamName,
    members,
    isAdmin,
    newTeamName,
    inviteEmail,
    inviteLink,
    webhooks,
    webhookProvider,
    webhookUrl,
    webhookSecret,
    message,
    error,
    createInvitation,
    createWebhook,
    revokeWebhook,
    copyValue,
    toggleMemberRole,
    removeMember,
    teamRunners,
    sharedRunners,
    availableRunners,
    enrollmentCode,
    enrollmentExpiresAt,
    createRunnerEnrollment,
    setSharedRunner,
    keys,
    keyName,
    keyToken,
    scopeOptions,
    issueKey,
    revokeKey,
    setScope,
    setFileMode,
    secrets,
    secretName,
    secretValue,
    fileMode,
    secretFileName,
    setSecretFile,
    saveSecret,
    deleteSecret,
  };
}
