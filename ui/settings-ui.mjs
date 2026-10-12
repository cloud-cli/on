import { onInit, ref } from "@li3/web";
import {
  applyThemePreference,
  getAuthPreference,
  isValidTimezone,
  loadTimezonePreference,
  setAuthPreference,
} from "@app/preferences.mjs";

export default function () {
  const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const theme = ref("system");
  const themeMessage = ref("");
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
  const loadPreferences = async () => {
    let authFailure;
    let savedTheme = null;
    let savedTimezone = null;
    try {
      savedTheme = await getAuthPreference("theme");
    } catch (reason) {
      authFailure = reason;
    }
    try {
      savedTimezone = await getAuthPreference("timezone");
    } catch (reason) {
      authFailure = reason;
    }
    if (["system", "light", "dark"].includes(savedTheme)) {
      theme.value = savedTheme;
    }
    applyThemePreference(theme.value);
    if (savedTimezone && isValidTimezone(savedTimezone)) {
      timezone.value = savedTimezone;
      if (!timezones.value.includes(savedTimezone)) {
        timezones.value = [...timezones.value, savedTimezone];
      }
    } else {
      try {
        const legacy = await loadTimezonePreference();
        if (legacy.timezone) {
          timezone.value = legacy.timezone;
          if (!timezones.value.includes(legacy.timezone)) {
            timezones.value = [...timezones.value, legacy.timezone];
          }
          authFailure = legacy.authError || authFailure;
        }
        if (savedTimezone && !isValidTimezone(savedTimezone)) {
          authFailure = legacy.authError || new Error("Saved Auth timezone is not a valid IANA timezone");
        }
      } catch (reason) {
        if (!authFailure) {
          authFailure = reason;
        }
      }
    }
    if (authFailure) {
      error.value = `Auth preferences are unavailable; using available defaults or legacy settings. ${authFailure.message}`;
    }
  };
  const saveTheme = async (event) => {
    const value = event.target.value;
    try {
      await setAuthPreference("theme", value);
      theme.value = value;
      applyThemePreference(value);
      themeMessage.value = "Appearance saved.";
    } catch (reason) {
      event.target.value = theme.value;
      error.value = reason.message;
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
      await setAuthPreference("timezone", selectedTimezone);
      timezone.value = selectedTimezone;
      preferenceMessage.value = `Timezone saved: ${selectedTimezone}.`;
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
    theme,
    themeMessage,
    saveTheme,
    timezones,
    preferenceMessage,
    error,
    saveTimezone,
    notificationsEnabled,
    notificationMessage,
    toggleNotifications,
  };
}
