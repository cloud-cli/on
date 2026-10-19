import { onInit, ref } from "@li3/web";

export default function () {
  const workers = ref([]);
  const runners = ref([]);
  const users = ref([]);
  const systemUsers = ref([]);
  const workspaces = ref([]);
  const tokens = ref([]);
  const message = ref("");
  const enrollmentMessage = ref("");
  const agentName = ref("");
  const agentEmail = ref("");
  const tokenSubject = ref("");
  const tokenName = ref("");
  const tokenValue = ref("");
  const workspaceId = ref("");
  const canManageUsers = ref(false);
  const canManageRunners = ref(false);
  const canManagePolicy = ref(false);
  const api = async (url, options = {}) => {
    const response = await fetch(url, {
      credentials: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    return data;
  };
  const load = async () => {
    try {
      const session = await api("/api/v1/auth/session");
      const capabilities = session.user?.capabilities || [];
      canManageUsers.value = capabilities.includes("platform.users.manage");
      canManageRunners.value = capabilities.includes("platform.runners.manage");
      canManagePolicy.value = capabilities.includes("platform.policy.manage");
      workers.value = (await api("/api/v1/workers").then((result) => result.workers || [])) || [];
      if (canManageRunners.value) {
        runners.value = (await api("/api/v1/runners").then((result) => result.runners || [])) || [];
      }
      users.value = canManageUsers.value ? await api("/api/v1/users").then((result) => result.users || []) : [];
      systemUsers.value = canManageUsers.value
        ? await api("/api/v1/system-users").then((result) => result.systemUsers || [])
        : [];
      workspaces.value = canManageUsers.value
        ? await api("/api/v1/platform/workspaces").then((result) => result.workspaces || [])
        : [];
      workspaceId.value = workspaceId.value || workspaces.value[0]?.id || "";
      await loadTokens();
    } catch (error) {
      message.value = error.message;
    }
  };
  const loadTokens = async () => {
    if (!workspaceId.value) {
      tokens.value = [];
      return;
    }
    try {
      const result = await api(`/api/v1/workspaces/${encodeURIComponent(workspaceId.value)}/tokens`);
      tokens.value = result.tokens || [];
    } catch {
      tokens.value = [];
    }
  };
  const setWorkspace = async (event) => {
    workspaceId.value = event.target.value;
    await loadTokens();
  };
  const enroll = async () => {
    try {
      const result = await api("/api/v1/runner-enrollments", {
        method: "POST",
        body: JSON.stringify({ scope: "shared" }),
      });
      enrollmentMessage.value = `Enrollment code: ${result.code} (expires ${result.expiresAt})`;
    } catch (error) {
      enrollmentMessage.value = error.message;
    }
  };
  const revokeRunner = async (runner) => {
    if (!window.confirm(`Revoke runner ${runner.name}?`)) {
      return;
    }
    try {
      await api(`/api/v1/runners/${encodeURIComponent(runner.id)}`, { method: "DELETE" });
      await load();
    } catch (error) {
      message.value = error.message;
    }
  };
  const updateRunner = async (runner) => {
    const version = window.prompt(`Target version for ${runner.name}?`);
    if (!version) {
      return;
    }
    try {
      await api(`/api/v1/runners/${encodeURIComponent(runner.id)}/update`, {
        method: "POST",
        body: JSON.stringify({ version }),
      });
      message.value = `Update requested for ${runner.name}.`;
      await load();
    } catch (error) {
      message.value = error.message;
    }
  };
  const renameRunner = async (runner) => {
    const name = window.prompt("Runner display name (1–32 characters)", runner.name);
    if (name === null || name.trim() === runner.name) {
      return;
    }
    try {
      await api(`/api/v1/runners/${encodeURIComponent(runner.id)}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      });
      await load();
    } catch (error) {
      message.value = error.message;
    }
  };
  const setRole = async (user, event) => {
    try {
      await api(`/api/v1/users/${encodeURIComponent(user.id)}/role`, {
        method: "PUT",
        body: JSON.stringify({ role: event.target.value }),
      });
      user.role = event.target.value;
    } catch (error) {
      message.value = error.message;
      event.target.value = user.role;
    }
  };
  const createSystemUser = async () => {
    try {
      await api("/api/v1/system-users", {
        method: "POST",
        body: JSON.stringify({ name: agentName.value, email: agentEmail.value || undefined }),
      });
      agentName.value = "";
      agentEmail.value = "";
      message.value = "System user created. Grant it workspace membership from the workspace settings page.";
      await load();
    } catch (error) {
      message.value = error.message;
    }
  };
  const setAgentName = (event) => {
    agentName.value = event.target.value;
  };
  const setAgentEmail = (event) => {
    agentEmail.value = event.target.value;
  };
  const toggleSystemUser = async (principal) => {
    try {
      await api(`/api/v1/system-users/${encodeURIComponent(principal.subject)}`, {
        method: "PUT",
        body: JSON.stringify({ disabled: !principal.disabled }),
      });
      await load();
    } catch (error) {
      message.value = error.message;
    }
  };
  const deleteSystemUser = async (principal) => {
    if (!window.confirm(`Permanently delete ${principal.name || principal.subject} and all of its tokens?`)) {
      return;
    }
    try {
      await api(`/api/v1/system-users/${encodeURIComponent(principal.subject)}`, { method: "DELETE" });
      await load();
    } catch (error) {
      message.value = error.message;
    }
  };
  const setTokenSubject = (event) => {
    tokenSubject.value = event.target.value;
  };
  const setTokenName = (event) => {
    tokenName.value = event.target.value;
  };
  const issueToken = async () => {
    try {
      const result = await api(`/api/v1/workspaces/${encodeURIComponent(workspaceId.value)}/tokens`, {
        method: "POST",
        body: JSON.stringify({ subject: tokenSubject.value, name: tokenName.value }),
      });
      tokenValue.value = result.token;
      tokenName.value = "";
      await loadTokens();
    } catch (error) {
      message.value = error.message;
    }
  };
  const revokeToken = async (token) => {
    if (!window.confirm(`Revoke ${token.name}?`)) {
      return;
    }
    try {
      await api(`/api/v1/workspaces/${encodeURIComponent(workspaceId.value)}/tokens/${encodeURIComponent(token.id)}`, {
        method: "DELETE",
      });
      await loadTokens();
    } catch (error) {
      message.value = error.message;
    }
  };
  onInit(() => void load());
  return {
    workers,
    runners,
    users,
    systemUsers,
    workspaces,
    tokens,
    message,
    enrollmentMessage,
    agentName,
    agentEmail,
    tokenSubject,
    tokenName,
    tokenValue,
    workspaceId,
    canManageUsers,
    canManageRunners,
    canManagePolicy,
    setWorkspace,
    setAgentName,
    setAgentEmail,
    createSystemUser,
    toggleSystemUser,
    deleteSystemUser,
    setTokenSubject,
    setTokenName,
    issueToken,
    revokeToken,
    enroll,
    renameRunner,
    revokeRunner,
    updateRunner,
    setRole,
  };
}
