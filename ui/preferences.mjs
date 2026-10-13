import { apiFetch } from "@app/api-client.mjs";

let colorSchemeListener;
let colorSchemeMedia;
let authModulePromise;

async function getAuthModule() {
  if (!authModulePromise) {
    authModulePromise = fetch("/api/auth/session", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Loading the authentication provider failed: ${response.status}`);
        }
        const session = await response.json();
        if (!session.providerUrl) {
          throw new Error("Authentication provider is not configured");
        }
        const moduleUrl = new URL("/index.mjs", `${session.providerUrl.replace(/\/+$/, "")}/`);
        return import(moduleUrl.href);
      })
      .catch((error) => {
        authModulePromise = undefined;
        throw error;
      });
  }
  return authModulePromise;
}

export async function getAuthPreference(key) {
  const auth = await getAuthModule();
  const property = await auth.getPropertyNS(`on:${key}`);
  if (typeof property === "string") {
    return property;
  }
  return typeof property?.value === "string" ? property.value : null;
}

export async function setAuthPreference(key, value) {
  const auth = await getAuthModule();
  await auth.setPropertyNS(`on:${key}`, value);
}

export function isValidTimezone(timezone) {
  if (typeof timezone !== "string" || !timezone.trim()) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function applyThemePreference(theme) {
  const preference = ["light", "dark"].includes(theme) ? theme : "system";
  if (preference === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = preference;
  }

  if (colorSchemeMedia && colorSchemeListener) {
    colorSchemeMedia.removeEventListener("change", colorSchemeListener);
  }
  colorSchemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  colorSchemeListener = () => {
    const isDark = preference === "dark" || (preference === "system" && colorSchemeMedia.matches);
    const themeColor = document.querySelector('meta[name="theme-color"]');
    if (themeColor) {
      themeColor.content = isDark ? "#0f1712" : "#eef2ec";
    }
  };
  colorSchemeListener();
  if (preference === "system") {
    colorSchemeMedia.addEventListener("change", colorSchemeListener);
  }
}

export async function loadTimezonePreference() {
  let authError;
  try {
    const timezone = await getAuthPreference("timezone");
    if (timezone) {
      if (isValidTimezone(timezone)) {
        return { timezone, source: "auth" };
      }
      authError = new Error("Saved Auth timezone is not a valid IANA timezone");
    }
  } catch (error) {
    authError = error;
  }

  try {
    const response = await apiFetch("/api/v1/preferences", { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Loading legacy timezone preference failed: ${response.status}`);
    }
    const { timezone } = await response.json();
    if (timezone && !isValidTimezone(timezone)) {
      throw new Error("Saved legacy timezone is not a valid IANA timezone");
    }
    if (timezone) {
      try {
        await setAuthPreference("timezone", timezone);
      } catch (error) {
        authError = error;
      }
    }
    return { timezone: timezone || null, source: authError ? "legacy-auth-unavailable" : "legacy", authError };
  } catch (legacyError) {
    return { timezone: null, source: "default", authError, legacyError };
  }
}
