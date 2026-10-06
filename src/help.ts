import { marked } from 'marked';
import workflowDocs from '../docs/workflow-syntax.md?raw';
export { workflowDocs };

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
    const classes = {
      1: 'mb-4 text-4xl font-semibold leading-tight tracking-tight text-gray-50',
      2: 'mt-12 border-t border-gray-800 pt-6 text-2xl font-semibold leading-tight tracking-tight text-gray-50',
      3: 'mt-8 text-lg font-semibold leading-tight tracking-tight text-gray-50',
    }[depth] || '';
    return `<h${depth} id="${id}" class="${classes}">${text}</h${depth}>`;
  };
  renderer.paragraph = ({ text }) => `<p class="my-4 text-slate-300">${text}</p>`;
  renderer.link = ({ href, title, text }) => `<a href="${href}"${title ? ` title="${title}"` : ''} class="text-blue-300 underline underline-offset-2 hover:text-blue-200">${text}</a>`;
  renderer.blockquote = ({ text }) => `<blockquote class="my-4 border-l-[3px] border-indigo-500 pl-4 text-slate-400">${text}</blockquote>`;
  renderer.code = ({ text }) => `<pre class="my-4 overflow-x-auto rounded-xl border border-gray-800 bg-gray-950 p-4"><code class="text-sm text-gray-300">${text}</code></pre>`;
  renderer.codespan = ({ text }) => `<code class="rounded bg-gray-900 px-1.5 py-0.5 text-[0.9em] text-blue-200">${text}</code>`;
  renderer.list = ({ items, ordered, start }) => {
    const tag = ordered ? 'ol' : 'ul';
    const typeClasses = ordered ? 'list-decimal' : 'list-disc';
    const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
    return `<${tag}${startAttr} class="my-4 space-y-1 pl-6 ${typeClasses} text-slate-300">${items.map((item) => item.text).join('')}</${tag}>`;
  };
  renderer.listitem = ({ text }) => `<li class="pl-1">${text}</li>`;
  renderer.table = ({ header, rows }) => `<table class="my-4 block w-full overflow-x-auto border-collapse text-left"><thead class="bg-gray-900 text-gray-50">${header}</thead><tbody>${rows.join('')}</tbody></table>`;
  renderer.tablerow = ({ text }) => `<tr>${text}</tr>`;
  renderer.tablecell = ({ text, header }) => `<${header ? 'th' : 'td'} class="border-b border-gray-800 px-3 py-2 align-top${header ? ' font-semibold' : ' text-slate-300'}">${text}</${header ? 'th' : 'td'}>`;
  const content = marked.parse(workflowDocs, { async: false, renderer }) as string;
  const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] || '');
  const toc = headings.length
    ? `<aside class="hidden lg:block"><nav class="sticky top-5 max-h-[calc(100vh-2.5rem)] overflow-y-auto border-l border-gray-800 pl-4" aria-label="On this page"><p class="mb-3 text-xs font-bold uppercase tracking-widest text-gray-50">On this page</p><ul class="grid list-none gap-1 m-0 p-0">${headings
        .map((heading) => `<li><a class="block rounded text-sm leading-snug text-slate-400 no-underline px-2 py-1 hover:bg-gray-900 hover:text-blue-100 focus-visible:bg-gray-900 focus-visible:text-blue-100 focus-visible:outline-none${heading.depth === 2 ? ' pl-4' : heading.depth === 3 ? ' pl-8 text-xs' : ''}" href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`)
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
      { "imports": { "@app/": "/", "@li3/": "https://at-li3.static.apphor.de/" } }
    </script>
    <link rel="component" href="/app-header.html" />
  </head>
  <body>
    ${navigation}
    <main class="mx-auto max-w-7xl px-4 py-8 pb-20 sm:px-6 sm:py-12 sm:pb-24"><div class="mx-auto grid max-w-7xl grid-cols-1 justify-center gap-12 lg:grid-cols-[minmax(0,54rem)_16rem]"><article class="mx-auto w-full max-w-4xl leading-[1.7]">${content}</article>${embed ? '' : toc}</div></main>
    <script type="module">import '@li3/web';</script>
  </body>
</html>`;
}
