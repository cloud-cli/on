import { describe, expect, it } from 'vitest';
import { generateSettingsHtml } from './settings-ui.js';
import settingsSetup from './settings-ui.mjs?raw';

describe('settings UI', () => {
  it('bootstraps the li3 application and API key controls', () => {
    const html = generateSettingsHtml();
    const source = html + settingsSetup;

    expect(source).toContain('https://at-li3.static.apphor.de/');
    expect(source).toContain('https://cdn.tailwindcss.com');
    expect(source).toContain('max-w-6xl');
    expect(source).toContain('/api/api-keys');
    expect(source).toContain('Issue key');
    expect(source).toContain('workflows:write');
    expect(source).toContain('Active tokens');
    expect(source).toContain('bg-gray-950/60');
    expect(source).toContain("page === 'tokens'");
    expect(source).not.toContain('Authenticated as the human administrator.');
    expect(source).toContain('peer-checked:bg-indigo-500');
    expect(source).toContain('peer-focus-visible:ring-2');
  });
});
