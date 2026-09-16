import { describe, expect, it } from 'vitest';
import routerTemplate from './app-router.html?raw';

describe('SPA router', () => {
  it('maps Settings and legacy workflow links into the settings workflow page', () => {
    expect(routerTemplate).toContain("path === '/settings' || path === '/workflows'");
    expect(routerTemplate).toContain("path.match(/^\\/workflows\\/(new|[a-z0-9-]+)$/)");
    expect(routerTemplate).toContain('if (target.pathname === window.location.pathname && target.hash) return;');
  });
});
