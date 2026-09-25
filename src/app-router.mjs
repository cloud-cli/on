import { getElement, load, onDestroy, onInit, templateRef } from '@li3/web';

export default function () {
  const outlet = templateRef('outlet');
  let navigating = false;
  const route = () => {
    const url = new URL(window.location.href);
    const path = url.pathname;
    if (path === '/' || path === '/runs') return { component: 'page-dashboard', url: '/pages/dashboard.html', page: 'dashboard' };
    if (path.match(/^\/runs\/\d+$/)) return { component: 'page-run', url: `/pages/run.html?jobId=${path.split('/').pop()}`, page: 'run' };
    if (path === '/help') return { component: 'page-help', url: '/pages/help.html', page: 'help' };
    if (path === '/settings/workflows') return { component: 'page-workflows', url: '/pages/workflows.html?page=workflows', page: 'workflows' };
    if (path === '/settings/secrets') return { component: 'page-secrets', url: '/pages/workflows.html?page=secrets', page: 'secrets' };
    if (path === '/settings/tokens') return { component: 'page-settings', url: '/pages/settings.html?page=tokens', page: 'tokens' };
    if (path === '/settings/notifications') return { component: 'page-settings', url: '/pages/settings.html?page=notifications', page: 'notifications' };
    if (path === '/settings/workers') return { component: 'page-settings', url: '/pages/settings.html?page=workers', page: 'workers' };
    if (path === '/settings' || path === '/workflows') return { component: 'page-workflows', url: '/pages/workflows.html?page=workflows', page: 'workflows' };
    const editor = path.match(/^\/settings\/workflows\/(new|[a-z0-9-]+)$/);
    if (editor) return { component: 'page-workflow-editor', url: `/pages/workflows.html?page=editor&id=${editor[1]}${url.searchParams.get('revision') ? `&revision=${url.searchParams.get('revision')}` : ''}`, page: 'editor' };
    const legacyEditor = path.match(/^\/workflows\/(new|[a-z0-9-]+)$/);
    if (legacyEditor) return { component: 'page-workflow-editor', url: `/pages/workflows.html?page=editor&id=${legacyEditor[1]}${url.searchParams.get('revision') ? `&revision=${url.searchParams.get('revision')}` : ''}`, page: 'editor' };
    return { component: 'page-dashboard', url: '/pages/dashboard.html', page: 'dashboard' };
  };
  const navigate = async (replace = false) => {
    if (navigating) return;
    navigating = true;
    try {
      const current = route();
      document.body.dataset.page = current.page;
      await load(current.url);
      outlet.value.replaceChildren(document.createElement(current.component));
      if (replace) history.replaceState(null, '', window.location.href);
    } catch (error) {
      outlet.value.innerHTML = `<main class="mx-auto max-w-4xl p-8"><h1 class="text-xl font-semibold text-white">Unable to load page</h1><p class="mt-2 text-sm text-rose-300">${String(error.message || error)}</p></main>`;
    } finally {
      navigating = false;
    }
  };
  const handleClick = (event) => {
    const anchor = event.target.closest?.('a');
    if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
    const target = new URL(anchor.href, window.location.href);
    if (target.origin !== window.location.origin || !target.pathname.startsWith('/') || target.pathname.startsWith('/auth/')) return;
    if (target.pathname === '/settings' || target.pathname.startsWith('/settings/') || target.pathname === '/workflows' || target.pathname.startsWith('/workflows/')) return;
    if (target.pathname.startsWith('/api/') || target.pathname.startsWith('/webhooks/')) return;
    if (target.pathname === window.location.pathname && target.hash) return;
    event.preventDefault();
    history.pushState(null, '', `${target.pathname}${target.search}${target.hash}`);
    void navigate();
  };
  const element = getElement();
  onInit(() => {
    element.addEventListener('click', handleClick);
    window.addEventListener('popstate', navigate);
    void navigate(true);
  });
  onDestroy(() => {
    element.removeEventListener('click', handleClick);
    window.removeEventListener('popstate', navigate);
  });
  return {};
}
