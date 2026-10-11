import { onInit, ref } from "@li3/web";
import { apiFetch } from "@app/api-client.mjs";

export default function () {
  const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const preferenceMessage = ref("");
  const error = ref("");
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
  const api = async (url, options = {}) => {
    const response = await apiFetch(url, {
      headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
      ...options,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.error || `Request failed: ${response.status}`);
    }
    return body;
  };
  const loadPreferences = async () => {
    const preferences = await api("/api/v1/preferences");
    if (preferences.timezone) {
      timezone.value = preferences.timezone;
      if (!timezones.value.includes(preferences.timezone)) {
        timezones.value = [...timezones.value, preferences.timezone];
      }
    }
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
      const saved = await api("/api/v1/preferences", {
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
  });
  return {
    timezone,
    timezones,
    preferenceMessage,
    error,
    saveTimezone,
    notificationsEnabled,
    notificationMessage,
    toggleNotifications,
  };
}
