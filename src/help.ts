import { marked } from 'marked';
import workflowDocs from '../docs/workflow-syntax.md?raw';

const styles = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #030712; color: #e5e7eb; font-family: ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 78rem; margin: 0 auto; padding: 2rem 1rem 5rem; }
  article { max-width: 54rem; margin: 0 auto; line-height: 1.7; }
  h1, h2, h3 { color: #f9fafb; line-height: 1.2; letter-spacing: -0.02em; }
  h1 { font-size: 2.25rem; margin: 0 0 1rem; }
  h2 { border-top: 1px solid #1f2937; margin-top: 3rem; padding-top: 1.5rem; font-size: 1.6rem; }
  h3 { margin-top: 2rem; font-size: 1.15rem; }
  p, li { color: #cbd5e1; }
  a { color: #93c5fd; }
  code { border-radius: .35rem; background: #111827; color: #bfdbfe; padding: .12rem .35rem; font-size: .9em; }
  pre { overflow-x: auto; border: 1px solid #1f2937; border-radius: .75rem; background: #0b1120; padding: 1rem; }
  pre code { background: transparent; padding: 0; color: #d1d5db; }
  table { width: 100%; border-collapse: collapse; display: block; overflow-x: auto; margin: 1rem 0; }
  th, td { border-bottom: 1px solid #1f2937; padding: .65rem .75rem; text-align: left; vertical-align: top; }
  th { color: #f9fafb; background: #111827; }
  blockquote { border-left: 3px solid #6366f1; margin-left: 0; padding-left: 1rem; color: #94a3b8; }
  .help-layout { display: grid; grid-template-columns: minmax(0, 54rem); gap: 3rem; justify-content: center; }
  .toc { display: none; }
  .toc nav { position: sticky; top: 1.25rem; max-height: calc(100vh - 2.5rem); overflow-y: auto; border-left: 1px solid #1f2937; padding-left: 1rem; }
  .toc-title { margin: 0 0 .65rem; color: #f9fafb; font-size: .75rem; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .toc ul { display: grid; gap: .15rem; list-style: none; margin: 0; padding: 0; }
  .toc a { display: block; border-radius: .35rem; color: #94a3b8; font-size: .8rem; line-height: 1.35; padding: .3rem .45rem; text-decoration: none; }
  .toc a:hover, .toc a:focus-visible { background: #111827; color: #dbeafe; outline: none; }
  .toc-depth-2 { padding-left: .9rem !important; }
  .toc-depth-3 { padding-left: 1.8rem !important; font-size: .75rem !important; }
  @media (min-width: 1024px) { .help-layout { grid-template-columns: minmax(0, 54rem) 16rem; justify-content: center; } .toc { display: block; } }
  @media (min-width: 640px) { main { padding: 3rem 1.5rem 6rem; } }
`;

export function renderHelpHtml(embed = false): string {
  const ids = new Map<string, number>();
  const headingId = (text: string) => {
    const base = text
      .replace(/[`*_~]/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'section';
    const count = ids.get(base) || 0;
    ids.set(base, count + 1);
    return count ? `${base}-${count + 1}` : base;
  };
  const headings = (marked.lexer(workflowDocs) as Array<{ type: string; depth?: number; text?: string }>)
    .filter((token) => token.type === 'heading' && (token.depth || 0) <= 3)
    .map((token) => ({ depth: token.depth!, text: token.text || '', id: headingId(token.text || '') }));
  ids.clear();
  let renderedHeadingIndex = 0;
  const renderer = new marked.Renderer();
  renderer.heading = ({ text, depth }) => {
    const id = headings[renderedHeadingIndex++]?.id || headingId(text);
    return `<h${depth} id="${id}">${text}</h${depth}>`;
  };
  const content = marked.parse(workflowDocs, { async: false, renderer }) as string;
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || '');
  const toc = headings.length
    ? `<aside class="toc"><nav aria-label="On this page"><p class="toc-title">On this page</p><ul>${headings
        .map((heading) => `<li><a class="toc-depth-${heading.depth}" href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
        .join('')}</ul></nav></aside>`
    : '';
  const navigation = embed
    ? ''
    : '<app-header title="Workflow Documentation" subtitle="" back="/runs" back-label="Back to dashboard"></app-header>';

  return `<!doctype html>
<html lang="en" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Workflow help</title>
    <script type="importmap">
      { "imports": { "@li3/": "https://cdn.li3.dev/@li3/" } }
    </script>
    <link rel="component" href="/app-header.html" />
    <style>${styles}</style>
  </head>
  <body>
    ${navigation}
    <main><div class="help-layout"><article>${content}</article>${embed ? '' : toc}</div></main>
    <script type="module">import '@li3/web';</script>
  </body>
</html>`;
}
