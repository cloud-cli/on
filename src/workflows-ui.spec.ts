import { describe, expect, it } from 'vitest';
import { generateWorkflowManagementHtml } from './workflows-ui.js';

describe('workflow management UI', () => {
  it('provides authenticated workflow and write-only secret controls', () => {
    const html = generateWorkflowManagementHtml();

    expect(html).toContain('id="source-yaml"');
    expect(html).toContain('/api/workflows/validate');
    expect(html).toContain('Save draft');
    expect(html).toContain('Publish');
    expect(html).toContain('/api/secrets/');
    expect(html).toContain('type="password"');
  });
});
