import { onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export default function () {
  const page = document.body.dataset.page;
  const keys = ref([]);
  const workers = ref([]);
  const users = ref([]);
  const usersForbidden = ref(false);
  const keyName = ref("");
  const newToken = ref("");
  const error = ref("");
  const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const preferenceMessage = ref("");
  const timezones = ref(
    typeof Intl.supportedValuesOf === "function"
      ? ["UTC", ...Intl.supportedValuesOf("timeZone")]
      : ["UTC", timezone.value],
  );
  const notificationsSupported = ref("Notification" in window && "serviceWorker" in navigator);
  const notificationsEnabled = ref(
    notificationsSupported.value &&
      Notification.permission === "granted" &&
      localStorage.getItem("runner-notifications") === "enabled",
  );
  const notificationMessage = ref("");
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
  const api = async (url, options = {}) => {
    const response = await apiFetch(url, {
      headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const reason = new Error(body.error || `Request failed: ${response.status}`);
      reason.status = response.status;
      throw reason;
    }
    return body;
  };
  const load = async () => {
    keys.value = (await api("/api/api-keys")).keys;
  };
  const loadWorkers = async () => {
    workers.value = (await api("/api/workers")).workers;
  };
  const loadUsers = async () => {
    try {
      users.value = (await api("/api/users")).users;
    } catch (reason) {
      if (reason.status === 403) {
        usersForbidden.value = true;
        return;
      }
      throw reason;
    }
  };
  const loadPreferences = async () => {
    const preferences = await api("/api/preferences");
    if (preferences.timezone) {
      timezone.value = preferences.timezone;
      if (!timezones.value.includes(preferences.timezone)) {
        timezones.value = [...timezones.value, preferences.timezone];
      }
    }
  };
  const formatTimestamp = (value) => {
    if (!value) {
      return "—";
    }
    const text = String(value);
    const date = new Date(text.includes("T") ? text : `${text.replace(" ", "T")}Z`);
    if (Number.isNaN(date.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone.value,
    }).format(date);
  };
  const saveTimezone = async (event) => {
    const previousTimezone = timezone.value;
    timezone.value = event.target.value;
    preferenceMessage.value = "";
    try {
      await api("/api/preferences", { method: "PUT", body: JSON.stringify({ timezone: timezone.value }) });
      preferenceMessage.value = "Timezone saved.";
    } catch (reason) {
      timezone.value = previousTimezone;
      error.value = reason.message;
    }
  };
  const issueKey = async () => {
    try {
      error.value = "";
      const result = await api("/api/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name: keyName.value,
          scopes: scopeOptions.value.filter((scope) => scope.selected).map((scope) => scope.name),
        }),
      });
      newToken.value = result.token;
      keyName.value = "";
      await load();
    } catch (reason) {
      error.value = reason.message;
    }
  };
  const revokeKey = async (key) => {
    if (!confirm(`Revoke ${key.name}?`)) {
      return;
    }
    try {
      await api(`/api/api-keys/${key.id}`, { method: "DELETE" });
      await load();
    } catch (reason) {
      error.value = reason.message;
    }
  };
  const toggleRole = async (user) => {
    const role = user.role === "admin" ? "user" : "admin";
    if (!confirm(`Change ${user.name || user.email || user.id} to ${role}?`)) {
      return;
    }
    error.value = "";
    try {
      await api(`/api/users/${encodeURIComponent(user.id)}/role`, { method: "PUT", body: JSON.stringify({ role }) });
      await loadUsers();
    } catch (reason) {
      error.value = reason.status === 403 ? "Only administrators can change user roles." : reason.message;
    }
  };
  const setKeyName = (event) => {
    keyName.value = event.target.value;
  };
  const toggleScope = (scope) => {
    scope.selected = !scope.selected;
  };
  const toggleNotifications = async () => {
    if (notificationsEnabled.value) {
      notificationsEnabled.value = false;
      localStorage.removeItem("runner-notifications");
      notificationMessage.value = "Notifications disabled on this device.";
      return;
    }
    if (!notificationsSupported.value) {
      notificationMessage.value = "Notifications are not supported by this browser.";
      return;
    }
    const permission = await Notification.requestPermission();
    notificationsEnabled.value = permission === "granted";
    if (notificationsEnabled.value) {
      localStorage.setItem("runner-notifications", "enabled");
      notificationMessage.value = "Notifications enabled.";
    } else {
      notificationMessage.value = "Notification permission was not granted.";
    }
  };
  onInit(() => {
    loadPreferences().catch((reason) => {
      error.value = reason.message;
    });
    if (page === "tokens") {
      load().catch((reason) => {
        error.value = reason.message;
      });
    }
    if (page === "workers") {
      loadWorkers().catch((reason) => {
        error.value = reason.message;
      });
    }
    if (page === "tokens") {
      loadUsers().catch((reason) => {
        error.value = reason.message;
      });
    }
  });
  return {
    page,
    keys,
    workers,
    users,
    usersForbidden,
    keyName,
    newToken,
    error,
    timezone,
    timezones,
    preferenceMessage,
    formatTimestamp,
    saveTimezone,
    scopeOptions,
    issueKey,
    revokeKey,
    setKeyName,
    toggleScope,
    toggleRole,
    notificationsEnabled,
    notificationMessage,
    toggleNotifications,
  };
}
