import { describe, expect, it } from 'vitest';
import { appIcon, serviceWorker, webManifest } from './pwa.js';

describe('PWA assets', () => {
  it('provides an installable manifest rooted at the dashboard', () => {
    expect(JSON.parse(webManifest)).toMatchObject({
      start_url: '/runs',
      scope: '/',
      display: 'standalone',
      icons: [{ src: '/app-icon.svg', sizes: 'any', type: 'image/svg+xml' }],
    });
    expect(appIcon).toContain('<svg');
  });

  it('opens the related run when a notification is selected', () => {
    expect(serviceWorker).toContain("self.addEventListener('notificationclick'");
    expect(serviceWorker).toContain('self.clients.openWindow(target)');
  });
});
