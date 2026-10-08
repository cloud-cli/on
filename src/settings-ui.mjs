import { onInit, ref, templateRef } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export default function () {
  const page = "settings";
  const keys = ref([]);
  const workers = ref([]);
  const workersForbidden = ref(false);
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
  const secrets = ref([]);
  const secretName = ref("");
  const secretValue = ref("");
  const fileMode = ref(false);
  const secretFileName = ref("");
  const secretFileData = ref("");
  const busy = ref(false);
  const secretForm = templateRef("secretForm");
  const secretValueInput = templateRef("secretValueInput");
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
  const loadSecrets = async () => {
    secrets.value = (await api("/api/secrets")).secrets;
  };
  const runSecretAction = async (action) => {
    if (busy.value) return;
    busy.value = true;
    error.value = "";
    try {
      await action();
    } catch (reason) {
      error.value = reason.message;
    } finally {
      busy.value = false;
    }
  };
  const saveSecret = () =>
    runSecretAction(async () => {
      const name = secretName.value.trim().toUpperCase();
      if (!/^[A-Z][A-Z0-9_]*$/.test(name))
        throw new Error("Secret names must start with a letter and contain only letters, numbers, and underscores.");
      if (fileMode.value ? !secretFileData.value : !secretValue.value)
        throw new Error(fileMode.value ? "Choose a file first." : "Set a secret value first.");
      await api(`/api/secrets/${encodeURIComponent(name)}`, {
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
      await loadSecrets();
    });
  const removeSecret = (name) => {
    if (!confirm(`Delete ${name}?`)) return;
    return runSecretAction(async () => {
      await api(`/api/secrets/${encodeURIComponent(name)}`, { method: "DELETE" });
      await loadSecrets();
    });
  };
  const setSecretFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    secretFileName.value = file.name;
    secretFileData.value = btoa(binary);
  };
  const setSecretName = (event) => {
    secretName.value = event.target.value;
  };
  const setSecretValue = (event) => {
    secretValue.value = event.target.value;
  };
  const setFileMode = (event) => {
    fileMode.value = event.target.checked;
  };
  const selectSecret = (name) => {
    secretName.value = name;
    fileMode.value = false;
    secretValue.value = "";
    if (secretForm.value) secretForm.value.open = true;
    secretForm.value?.scrollIntoView({ behavior: "smooth", block: "center" });
    secretValueInput.value?.focus({ preventScroll: true });
  };
  const loadWorkers = async () => {
    try {
      workers.value = (await api("/api/workers")).workers;
    } catch (reason) {
      if (reason.status === 403) {
        workersForbidden.value = true;
        return;
      }
      throw reason;
    }
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
    const selectedTimezone = event.target.value.trim();
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: selectedTimezone });
    } catch {
      preferenceMessage.value = "Enter a valid IANA timezone, such as Europe/Paris.";
      event.target.value = previousTimezone;
      return;
    }
    timezone.value = selectedTimezone;
    preferenceMessage.value = "";
    try {
      const saved = await api("/api/preferences", {
        method: "PUT",
        body: JSON.stringify({ timezone: selectedTimezone }),
      });
      timezone.value = saved.timezone;
      preferenceMessage.value = `Timezone saved: ${saved.timezone}.`;
    } catch (reason) {
      timezone.value = previousTimezone;
      event.target.value = previousTimezone;
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
    load().catch((reason) => {
      error.value = reason.message;
    });
    loadSecrets().catch((reason) => {
      error.value = reason.message;
    });
    loadWorkers().catch((reason) => {
      error.value = reason.message;
    });
    loadUsers().catch((reason) => {
      error.value = reason.message;
    });
  });
  return {
    page,
    secrets,
    secretForm,
    secretValueInput,
    secretName,
    secretValue,
    fileMode,
    busy,
    saveSecret,
    removeSecret,
    setSecretFile,
    setSecretName,
    setSecretValue,
    setFileMode,
    selectSecret,
    keys,
    workers,
    workersForbidden,
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
