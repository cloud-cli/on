export function workspaceIdFromPathname(pathname) {
  const path = pathname.replace(/^\/ui(?=\/|$)/, "");
  const settingsRoute = path.match(/^\/(?:teams|workspaces)\/([^/]+)\/settings$/);
  if (!settingsRoute) {
    return "";
  }

  try {
    return decodeURIComponent(settingsRoute[1]);
  } catch {
    return "";
  }
}
