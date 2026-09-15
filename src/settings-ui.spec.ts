import { describe, expect, it } from 'vitest';
import { generateSettingsHtml } from './settings-ui.js';

describe('settings UI', () => {
  it('bootstraps the li3 application and API key controls', () => {
    const html = generateSettingsHtml();

    expect(html).toContain('https://cdn.li3.dev/@li3/');
    expect(html).toContain('https://cdn.tailwindcss.com');
    expect(html).toContain('max-w-6xl');
    expect(html).toContain('/api/api-keys');
    expect(html).toContain('Issue key');
    expect(html).toContain('workflows:write');
    expect(html).toContain('peer-checked:bg-indigo-500');
    expect(html).toContain('peer-focus-visible:ring-2');
  });
});
