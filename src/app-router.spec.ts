import { describe, expect, it } from 'vitest';
import routerTemplate from './app-router.html?raw';
import routerSetup from './app-router.mjs?raw';

describe('SPA router', () => {
  it('maps Settings and legacy workflow links into the settings workflow page', () => {
    expect(routerTemplate).toContain('<script setup src="@app/app-router.mjs"></script>');
    expect(routerSetup).toContain("path === '/settings' || path === '/workflows'");
    expect(routerSetup).toContain("path.match(/^\\/workflows\\/(new|[a-z0-9-]+)$/)");
    expect(routerSetup).toContain('if (target.pathname === window.location.pathname && target.hash) return;');
  });
});
