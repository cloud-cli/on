export interface ErrorPageAction {
  label: string;
  href: string;
}

export interface ErrorPageOptions {
  status: number;
  title: string;
  message: string;
  action?: ErrorPageAction;
  secondaryAction?: ErrorPageAction;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function actionLink(action: ErrorPageAction, primary: boolean): string {
  const className = primary ? "action action-primary" : "action action-secondary";
  const href = action.href.startsWith("/") && !action.href.startsWith("//") && !/[\\\r\n\u0000-\u001f]/.test(action.href)
    ? action.href
    : "/runs";
  return `<a class="${className}" href="${escapeHtml(href)}">${escapeHtml(action.label)}</a>`;
}

export function renderErrorPage({ status, title, message, action, secondaryAction }: ErrorPageOptions): string {
  const actions = [action && actionLink(action, true), secondaryAction && actionLink(secondaryAction, false)]
    .filter(Boolean)
    .join("\n          ");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${status} — ${escapeHtml(title)} · Flow</title>
    <style>
      :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #19231e; background: #f3f6f1; font-synthesis: none; }
      * { box-sizing: border-box; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; padding: 28px 18px; }
      .page { width: min(100%, 520px); }
      .brand { display: flex; align-items: center; gap: 11px; margin: 0 0 22px 4px; color: #243b2a; font-size: 17px; font-weight: 700; letter-spacing: -.03em; }
      .brand-mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 11px; color: #fff; background: #387045; box-shadow: 0 3px 8px #23492c26; }
      .card { padding: clamp(25px, 7vw, 42px); border: 1px solid #dce4da; border-radius: 18px; background: #fff; box-shadow: 0 14px 45px #213a2810; }
      .status { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px; color: #536457; background: #f1f5ef; font-size: 12px; font-weight: 650; letter-spacing: .035em; }
      .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #b57b30; }
      h1 { margin: 20px 0 10px; font-size: clamp(27px, 6vw, 34px); line-height: 1.16; letter-spacing: -.045em; }
      p { margin: 0; color: #5b685e; font-size: 15px; line-height: 1.65; }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 28px; }
      .action { min-height: 43px; display: inline-flex; align-items: center; justify-content: center; padding: 0 16px; border: 1px solid transparent; border-radius: 9px; text-decoration: none; font-size: 14px; font-weight: 650; transition: background .15s ease, border-color .15s ease; }
      .action-primary { color: #fff; background: #387045; }
      .action-primary:hover { background: #2d5c39; }
      .action-secondary { color: #33483a; border-color: #dce4da; background: #fff; }
      .action-secondary:hover { background: #f5f7f4; }
      a:focus-visible { outline: 3px solid #7cac84; outline-offset: 3px; }
      footer { margin: 18px 4px 0; color: #78847a; font-size: 12px; }
      @media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition-duration: .01ms !important; } }
    </style>
  </head>
  <body>
    <main class="page">
      <div class="brand"><span class="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 12.5 9.2 17 19 7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg></span>Flow</div>
      <section class="card" aria-labelledby="error-title">
        <div class="status"><span class="status-dot" aria-hidden="true"></span>ERROR ${status}</div>
        <h1 id="error-title">${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        ${actions ? `<nav class="actions" aria-label="Next steps">${actions}</nav>` : ""}
      </section>
      <footer>Need help? Contact your Flow administrator.</footer>
    </main>
  </body>
</html>`;
}
