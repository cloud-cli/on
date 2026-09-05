import { describe, expect, it } from 'vitest';
import { generateWorkflowManagementHtml } from './workflows-ui.js';

describe('workflow management UI', () => {
  it('provides authenticated workflow and write-only secret controls', () => {
    const html = generateWorkflowManagementHtml('editor', 'example');

    expect(html).toContain('<code-editor');
    expect(html).toContain('id="source-yaml"');
    expect(html).toContain('https://sodium.static.apphor.de/code-editor.html');
    expect(html).toContain('https://sodium.static.apphor.de/lucide-icon.html');
    expect(html).toContain('<template app>');
    expect(html).toContain('/api/workflows/validate');
    expect(html).toContain('Save draft');
    expect(html).toContain('Publish');
    expect(html).toContain('/api/secrets/');
    expect(html).toContain('type="password"');
    expect(html).toContain('data-page="editor"');
    expect(html).toContain('const initialId = "example"');
  });
});
