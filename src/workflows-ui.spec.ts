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
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('bind-checked="enabled"');
    expect(html).toContain('aria-labelledby="workflow-list-title"');
    expect(html).toContain('attr-href="\'/workflows/\' + workflow.id"');
    expect(html).toContain('focus-visible:ring-2');
    expect(html).toContain('Publish');
    expect(html).toContain('/api/secrets/');
    expect(html).toContain('type="password"');
    expect(html).toContain('aria-label="Saved secrets"');
    expect(html).toContain('aria-label="Edit secret {{ name }}"');
    expect(html).toContain('data-page="editor"');
    expect(html).toContain('const initialId = "example"');
  });
});
