let token = sessionStorage.getItem("runner-api-token") || "";
let expiresAt = token ? Number.MAX_SAFE_INTEGER : 0;

const rawFetch = window.fetch.bind(window);
let teamLookup;

async function ensureTeamSelection() {
  if (typeof localStorage === "undefined") return "";
  const current = localStorage.getItem("runner-team-id");
  if (current) return current;
  if (!teamLookup) {
    teamLookup = rawFetch("/api/teams", { headers: { accept: "application/json" } })
      .then(async (response) => (response.ok ? (await response.json()).teams || [] : []))
      .catch(() => []);
  }
  const teams = await teamLookup;
  if (!teams.length) return "";
  localStorage.setItem("runner-team-id", teams[0].id);
  return teams[0].id;
}

export async function loadToken() {
  if (token && expiresAt > Date.now() + 30_000) return token;
  const response = await rawFetch("/api/auth/token", {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    if (response.status === 401) {
      // When /api/auth/token returns 401, clear OIDC in-memory token state and redirect
      // to login so the user can re-authenticate. This even applies when there was
      // no prior cached token, fixing the reported symptom where 401 was silently
      // swallowed and settings APIs stayed broken.
      token = "";
      expiresAt = 0;
      if (sessionStorage.getItem("runner-api-token")) {
        sessionStorage.removeItem("runner-api-token");
      }
      const returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.assign(`/auth/login?url=${encodeURIComponent(returnTo)}`);
    }
    return "";
  }
  const data = await response.json();
  token = data.access_token || "";
  expiresAt = Number(data.expires_at || 0);
  return token;
}

export async function apiFetch(input, init = {}) {
  const target = new URL(input, window.location.href);
  if (
    target.origin !== window.location.origin ||
    (!target.pathname.startsWith("/api/") && !target.pathname.startsWith("/restart/"))
  ) {
    return rawFetch(input, init);
  }
  const headers = new Headers(init.headers);
  if (!headers.has("X-Team-ID")) {
    const teamId = await ensureTeamSelection();
    if (teamId) headers.set("X-Team-ID", teamId);
  }
  const accessToken = await loadToken();
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  return rawFetch(input, { ...init, headers });
}

export function setApiToken(value) {
  token = value || "";
  expiresAt = token ? Number.MAX_SAFE_INTEGER : 0;
  if (token) sessionStorage.setItem("runner-api-token", token);
  else sessionStorage.removeItem("runner-api-token");
}
