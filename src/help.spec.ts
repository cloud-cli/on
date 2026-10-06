import { describe, expect, it } from 'vitest';
import { renderHelpHtml } from './help.js';

describe('workflow help', () => {
  it('renders the living workflow documentation', () => {
    const html = renderHelpHtml();

    expect(html).toContain('<title>Workflow help</title>');
    expect(html).toContain('<app-header title="Workflow Documentation" subtitle="" back="/runs"');
    expect(html).toContain('Your First Workflow');
    expect(html).toContain('Environment and Expressions');
    expect(html).toContain('Docker Volumes and Trust');
    expect(html).toContain('id="workflow-documentation"');
    expect(html).toContain('On this page');
    expect(html).toContain('href="#tutorials"');
    expect(html).toContain('<app-header title="Workflow Documentation"');
    expect(html).toContain('https://at-li3.static.apphor.de/');
    expect(html).toContain('back="/runs"');
    expect(html).not.toContain('onclick="history.back()"');
    expect(html).not.toMatch(/<style\b/i);
    expect(html).toContain('grid-cols-1');
    expect(html).toContain('bg-gray-950');
    expect(html).toContain('overflow-x-auto rounded-xl border');
  });

  it('supports an embedded view without global navigation', () => {
    const html = renderHelpHtml(true);

    expect(html).toContain('Workflow Documentation');
    expect(html).not.toContain('On this page');
    expect(html).not.toContain('Back to jobs');
    expect(html).not.toMatch(/<style\b/i);
  });
});
