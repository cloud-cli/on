let token = sessionStorage.getItem("runner-api-token") || "";
let expiresAt = token ? Number.MAX_SAFE_INTEGER : 0;
const rawFetch = window.fetch.bind(window);

function loginUrl(nonce) {
  const returnUrl = new URL(window.location.href);
  returnUrl.searchParams.set("__runner_auth_nonce", nonce);
  return `/auth/login?url=${encodeURIComponent(`${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`)}`;
}

function recoveryFlag(nonce) {
  return `runner-auth-recovery:${nonce}`;
}

function ensureDialog() {
  let dialog = document.getElementById("runner-auth-dialog");
  if (dialog) {
    return dialog;
  }
  dialog = document.createElement("dialog");
  dialog.id = "runner-auth-dialog";
  dialog.setAttribute("aria-labelledby", "runner-auth-title");
  dialog.className =
    "max-w-[calc(100vw-2rem)] rounded-xl border border-flow-border bg-flow-sidebar p-6 text-flow-foreground shadow-xl backdrop:bg-black/50";
  dialog.innerHTML = `<form method="dialog" class="max-w-md space-y-4"><h2 id="runner-auth-title" class="text-lg font-semibold">Sign in required</h2><p>Your session expired. Sign in to continue; this page and its unsaved work will stay open.</p><p role="status" data-auth-status class="text-sm text-flow-secondary"></p><div class="flex justify-end gap-3"><button type="button" data-auth-cancel class="rounded-md border border-flow-border px-4 py-2">Cancel</button><button type="button" data-auth-login class="rounded-md bg-flow-primary px-4 py-2 font-medium text-white">Sign in</button></div></form>`;
  dialog.querySelector("[data-auth-login]").addEventListener("click", () => startLogin());
  dialog.querySelector("[data-auth-cancel]").addEventListener("click", () => {
    dialog.close();
    finishPending(false);
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finishPending(false);
  });
  document.body.append(dialog);
  return dialog;
}

let activeNonce = "";
let popup = null;
let pollTimer;
let closePollTimer;
let resolveRecovery;
let checkingSession;
function finishPending(success) {
  clearInterval(pollTimer);
  clearInterval(closePollTimer);
  if (activeNonce) {
    localStorage.removeItem(recoveryFlag(activeNonce));
  }
  if (!success && popup && !popup.closed) {
    popup.close();
  }
  popup = null;
  activeNonce = "";
  ensureDialog().close();
  const resolve = resolveRecovery;
  resolveRecovery = null;
  if (resolve) {
    resolve(success);
  }
}

function startLogin() {
  if (!activeNonce) {
    return;
  }
  const status = ensureDialog().querySelector("[data-auth-status]");
  const width = 520;
  const height = 720;
  const left = Math.max(0, (window.screenX || 0) + ((window.outerWidth || width) - width) / 2);
  const top = Math.max(0, (window.screenY || 0) + ((window.outerHeight || height) - height) / 2);
  popup = window.open(
    loginUrl(activeNonce),
    "runner-auth",
    `popup,width=${width},height=${height},left=${left},top=${top}`,
  );
  if (!popup) {
    status.textContent = "The sign-in window was blocked. Allow pop-ups, then try again.";
    return;
  }
  status.textContent = "Complete sign-in in the new window. This page will resume automatically.";
  clearInterval(closePollTimer);
  closePollTimer = setInterval(() => {
    if (popup?.closed) {
      clearInterval(closePollTimer);
      popup = null;
      status.textContent = "Sign-in window closed. You can try again.";
    }
  }, 500);
}

async function checkRecoverySession() {
  if (!activeNonce || checkingSession || localStorage.getItem(recoveryFlag(activeNonce)) !== "complete") {
    return;
  }
  checkingSession = (async () => {
    try {
      const response = await rawFetch("/api/auth/session", {
        credentials: "same-origin",
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      const session = response.ok ? await response.json().catch(() => null) : null;
      if (activeNonce && session?.authenticated) {
        finishPending(true);
      }
    } catch {
    } finally {
      checkingSession = undefined;
    }
  })();
  await checkingSession;
}

function recover() {
  if (activeNonce) {
    return new Promise((resolve) => {
      const prior = resolveRecovery;
      resolveRecovery = (ok) => {
        prior?.(ok);
        resolve(ok);
      };
    });
  }
  activeNonce = crypto.randomUUID();
  localStorage.setItem(recoveryFlag(activeNonce), "pending");
  const dialog = ensureDialog();
  dialog.querySelector("[data-auth-status]").textContent = "";
  dialog.showModal();
  pollTimer = setInterval(checkRecoverySession, 5_000);
  void checkRecoverySession();
  return new Promise((resolve) => {
    resolveRecovery = resolve;
  });
}

// The popup may close only after its login callback confirms the RP session.
const callbackUrl = new URL(window.location.href);
const callbackNonce = callbackUrl.searchParams.get("__runner_auth_nonce");
if (
  callbackNonce &&
  window.opener &&
  window.opener !== window &&
  localStorage.getItem(recoveryFlag(callbackNonce)) === "pending"
) {
  callbackUrl.searchParams.delete("__runner_auth_nonce");
  history.replaceState(null, "", `${callbackUrl.pathname}${callbackUrl.search}${callbackUrl.hash}`);
  rawFetch("/api/auth/session", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then((response) => (response.ok ? response.json() : null))
    .then((session) => {
      if (session?.authenticated && localStorage.getItem(recoveryFlag(callbackNonce)) === "pending") {
        localStorage.setItem(recoveryFlag(callbackNonce), "complete");
        window.close();
      }
    })
    .catch(() => {});
}

window.addEventListener?.("focus", checkRecoverySession);

async function acquireToken() {
  if (token && expiresAt > Date.now() + 30_000) {
    return { token, authRequired: false };
  }
  const response = await rawFetch("/api/auth/token", { headers: { accept: "application/json" } });
  if (!response.ok) {
    const authRequired = await isAuthRequired(response);
    if (authRequired) {
      token = "";
      expiresAt = 0;
      sessionStorage.removeItem("runner-api-token");
    }
    return { token: "", authRequired, response };
  }
  const data = await response.json();
  token = data.access_token || "";
  expiresAt = Number(data.expires_at || 0);
  return { token, authRequired: false };
}

export async function loadToken() {
  return (await acquireToken()).token;
}

async function isAuthRequired(response) {
  if (response.status !== 401) {
    return false;
  }
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  return body?.error === "Authentication required";
}

export async function apiFetch(input, init = {}) {
  const target = new URL(input, window.location.href);
  if (
    target.origin !== window.location.origin ||
    (!target.pathname.startsWith("/api/") && !target.pathname.startsWith("/restart/"))
  ) {
    return rawFetch(input, init);
  }
  let acquired = await acquireToken();
  if (acquired.authRequired) {
    if (!(await recover())) {
      return acquired.response;
    }
    token = "";
    expiresAt = 0;
    sessionStorage.removeItem("runner-api-token");
    acquired = await acquireToken();
    if (acquired.authRequired) {
      return acquired.response;
    }
  }
  const headers = new Headers(init.headers);
  if (acquired.token) {
    headers.set("authorization", `Bearer ${acquired.token}`);
  }
  const response = await rawFetch(input, { ...init, headers });
  if (!(await isAuthRequired(response))) {
    return response;
  }
  if (!(await recover())) {
    return response;
  }
  token = "";
  expiresAt = 0;
  sessionStorage.removeItem("runner-api-token");
  const retryHeaders = new Headers(init.headers);
  const retryToken = await acquireToken();
  if (retryToken.authRequired) {
    return retryToken.response;
  }
  if (retryToken.token) {
    retryHeaders.set("authorization", `Bearer ${retryToken.token}`);
  }
  return rawFetch(input, { ...init, headers: retryHeaders });
}

export function setApiToken(value) {
  token = value || "";
  expiresAt = token ? Number.MAX_SAFE_INTEGER : 0;
  if (token) {
    sessionStorage.setItem("runner-api-token", token);
  } else {
    sessionStorage.removeItem("runner-api-token");
  }
}
