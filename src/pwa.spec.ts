import { describe, expect, it } from "vitest";
import { appIcon, getAppIcon, serviceWorker, webManifest } from "./pwa.js";

describe("PWA assets", () => {
  it("provides an installable manifest rooted at the dashboard", () => {
    expect(JSON.parse(webManifest)).toMatchObject({
      start_url: "/runs",
      scope: "/",
      display: "standalone",
      name: "Flow",
      short_name: "Flow",
      background_color: "#263d32",
      theme_color: "#263d32",
      icons: [{ src: "/app-icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
    });
    expect(appIcon).toContain("<svg");
    expect(appIcon).toContain('fill="#263d32"');
    expect(appIcon).toContain('fill="#c8e6a8"');
    expect(appIcon).toContain("M112 185 400 118");
    expect(appIcon).not.toContain("terminal");
  });

  it("opens the related run when a notification is selected", () => {
    expect(serviceWorker).toContain("self.addEventListener('notificationclick'");
    expect(serviceWorker).toContain("self.clients.openWindow(target)");
    expect(serviceWorker).toContain("self.addEventListener('push'");
  });

  it("uses a dark navy background for beta while leaving the production icon unchanged", () => {
    expect(getAppIcon()).toBe(appIcon);
    expect(getAppIcon(false)).toBe(appIcon);
    expect(getAppIcon(true)).toContain('fill="#101b3f"');
    expect(getAppIcon(true)).toContain('fill="#c8e6a8"');
    expect(getAppIcon(true)).not.toContain('fill="#263d32"');
  });
});
