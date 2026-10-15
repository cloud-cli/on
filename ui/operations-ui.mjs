import { onInit, ref } from "@li3/web";

export default function () {
  const workers = ref([]);
  const runners = ref([]);
  const users = ref([]);
  const message = ref("");
  const enrollmentMessage = ref("");
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
      [workers.value, runners.value, users.value] = await Promise.all([
        api("/api/v1/workers").then((result) => result.workers || []),
        api("/api/v1/runners").then((result) => result.runners || []),
        api("/api/v1/users").then((result) => result.users || []),
      ]);
    } catch (error) {
      message.value = error.message;
    }
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
  onInit(() => void load());
  return {
    workers,
    runners,
    users,
    message,
    enrollmentMessage,
    enroll,
    renameRunner,
    revokeRunner,
    updateRunner,
    setRole,
  };
}
