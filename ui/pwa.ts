export const webManifest = JSON.stringify({
  id: "/ui/runs",
  name: "on:",
  short_name: "on:",
  description: "Follow CI/CD runs, workflows, and results.",
  start_url: "/ui/runs",
  scope: "/ui/",
  display: "standalone",
  background_color: "#263d32",
  theme_color: "#263d32",
  icons: [
    {
      src: "/assets/app-icon.svg",
      sizes: "any",
      type: "image/svg+xml",
      purpose: "any maskable",
    },
  ],
});

export const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="#263d32"/>
  <g fill="#c8e6a8">
    <path d="M112 185 400 118v44l-288 67z"/>
    <path d="M112 253 324 204v44l-212 49z"/>
    <path d="M112 321 250 289v44l-138 32z"/>
  </g>
</svg>`;

export function getAppIcon(beta = false): string {
  if (!beta) {
    return appIcon;
  }
  return appIcon.replace('fill="#263d32"', 'fill="#101b3f"');
}

export const serviceWorker = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  const data = event.data?.json() || {};
  event.waitUntil(self.registration.showNotification(data.title || 'on:', {
    body: data.body || 'A workflow run changed.',
    icon: '/assets/app-icon.svg',
    badge: '/assets/app-icon.svg',
    data: { url: data.url || '/ui/runs' },
  }));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/ui/runs';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).pathname === target);
    if (existing) return existing.focus();
    return self.clients.openWindow(target);
  })());
});`;
