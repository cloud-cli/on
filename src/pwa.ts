export const webManifest = JSON.stringify({
  id: '/runs',
  name: 'Runner Engine',
  short_name: 'Runner',
  description: 'Follow CI/CD jobs and execution results.',
  start_url: '/runs',
  scope: '/',
  display: 'standalone',
  background_color: '#030712',
  theme_color: '#030712',
  icons: [
    {
      src: '/app-icon.svg',
      sizes: 'any',
      type: 'image/svg+xml',
      purpose: 'any maskable',
    },
  ],
});

export const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="#030712"/>
  <path d="M128 144h256v224H128z" fill="#111827" stroke="#6366f1" stroke-width="24"/>
  <path d="m174 218 62 38-62 38M260 300h78" fill="none" stroke="#f9fafb" stroke-linecap="round" stroke-linejoin="round" stroke-width="24"/>
  <circle cx="365" cy="147" r="47" fill="#10b981" stroke="#030712" stroke-width="18"/>
</svg>`;

export const serviceWorker = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = event.notification.data?.url || '/runs';
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).pathname === target);
    if (existing) return existing.focus();
    return self.clients.openWindow(target);
  })());
});`;
