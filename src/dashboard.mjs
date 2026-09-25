import { onDestroy, onInit, ref } from '@li3/web';
import { apiFetch } from '@app/api-client.mjs';

export default function setup() {
  const jobs = ref([]), refreshError = ref(false), hasMore = ref(false), loadingMore = ref(false);
  const filter = ref(''), activeFilter = ref(''), pushConfigured = ref(false);
  const notificationsSupported = ref('Notification' in window && 'serviceWorker' in navigator);
  const notificationsEnabled = ref(notificationsSupported.value && Notification.permission === 'granted' && localStorage.getItem('runner-notifications') === 'enabled');
  const notificationNotice = ref('');
  let refreshTimer, eventSource, refreshing = false, refreshPending = false, searchInProgress = false, refreshGeneration = 0;
  const upper = (value) => String(value || '').toUpperCase();
  const terminalStatuses = new Set(['success', 'failed', 'cancelled']);
  const notifyCompletedJob = async (job) => {
    if (!notificationsEnabled.value || pushConfigured.value || !['success', 'failed'].includes(job.status)) return;
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(job.status === 'success' ? `Job #${job.id} succeeded` : `Job #${job.id} failed`, { body: `${job.workflowId} finished with status ${job.status}.`, icon: '/app-icon.svg', badge: '/app-icon.svg', tag: `runner-job-${job.id}`, renotify: true, data: { url: `/runs/${job.id}` } });
    } catch (error) { console.error('Unable to show job notification', error); }
  };
  const urlBase64ToUint8Array = (value) => { const padding = '='.repeat((4 - (value.length % 4)) % 4); const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((character) => character.charCodeAt(0))); };
  const enablePushNotifications = async () => {
    try {
      if (!notificationsSupported.value) return;
      const response = await apiFetch('/api/push/public-key', { headers: { accept: 'application/json' } });
      if (!response.ok) return;
      const { publicKey } = await response.json(); pushConfigured.value = true;
      const registration = await navigator.serviceWorker.ready;
      const subscription = (await registration.pushManager.getSubscription()) || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      const saved = await apiFetch('/api/push/subscriptions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) });
      if (!saved.ok) throw new Error(`Push subscription failed: ${saved.status}`);
    } catch (error) { console.error('Unable to enable background notifications', error); }
  };
  const disablePushNotifications = async () => {
    try { const subscription = await (await navigator.serviceWorker.ready).pushManager.getSubscription(); if (!subscription) return; await apiFetch('/api/push/subscriptions', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: subscription.endpoint }) }); await subscription.unsubscribe(); }
    catch (error) { console.error('Unable to disable background notifications', error); }
  };
  const toggleNotifications = async () => {
    if (notificationsEnabled.value) { notificationsEnabled.value = false; localStorage.removeItem('runner-notifications'); await disablePushNotifications(); notificationNotice.value = 'Job notifications are paused on this device.'; return; }
    if (Notification.permission === 'denied') { notificationNotice.value = 'Notifications are blocked. Allow them in this site’s Android browser settings.'; return; }
    notificationsEnabled.value = (await Notification.requestPermission()) === 'granted';
    if (notificationsEnabled.value) { localStorage.setItem('runner-notifications', 'enabled'); await enablePushNotifications(); notificationNotice.value = 'Notifications enabled. Background delivery is available when server push is configured.'; } else notificationNotice.value = 'Notification permission was not granted.';
  };
  const refreshJobs = async (isSearch = false) => {
    if (searchInProgress && !isSearch) return; if (refreshing && !isSearch) { refreshPending = true; return; }
    refreshing = true; const generation = refreshGeneration;
    try {
      const activeIds = jobs.value.filter((job) => !terminalStatuses.has(job.status)).map((job) => Number(job.id));
      const knownIds = jobs.value.map((job) => Number(job.id));
      const afterId = activeIds.length ? Math.max(0, Math.min(...activeIds) - 1) : knownIds.length ? Math.max(...knownIds) : null;
      const filterQuery = activeFilter.value ? `&filter=${encodeURIComponent(activeFilter.value)}` : '';
      const url = afterId === null ? `/api/jobs?limit=100${filterQuery}` : `/api/jobs?afterId=${afterId}&limit=100${filterQuery}`;
      const response = await apiFetch(url, { headers: { accept: 'application/json' } }); if (!response.ok) throw new Error(`Dashboard refresh failed: ${response.status}`);
      const data = await response.json(); if (generation !== refreshGeneration) return; hasMore.value = data.hasMore;
      const previousStatuses = new Map(jobs.value.map((job) => [job.id, job.status])); const merged = new Map(jobs.value.map((job) => [job.id, job]));
      for (const job of data.jobs) { const previousStatus = previousStatuses.get(job.id); merged.set(job.id, job); if (previousStatus && !terminalStatuses.has(previousStatus) && terminalStatuses.has(job.status)) void notifyCompletedJob(job); }
      jobs.value = Array.from(merged.values()).sort((a, b) => Number(b.id) - Number(a.id)); refreshError.value = false;
    } catch (error) { console.error(error); refreshError.value = true; } finally { refreshing = false; if (refreshPending && !searchInProgress) { refreshPending = false; void refreshJobs(); } }
  };
  const loadMore = async () => { if (loadingMore.value || !hasMore.value || !jobs.value.length) return; loadingMore.value = true; try { const beforeId = Math.min(...jobs.value.map((job) => Number(job.id))); const filterQuery = activeFilter.value ? `&filter=${encodeURIComponent(activeFilter.value)}` : ''; const response = await apiFetch(`/api/jobs?beforeId=${beforeId}${filterQuery}`, { headers: { accept: 'application/json' } }); if (!response.ok) throw new Error(`Loading older jobs failed: ${response.status}`); const data = await response.json(); const merged = new Map(jobs.value.map((job) => [job.id, job])); for (const job of data.jobs) merged.set(job.id, job); jobs.value = Array.from(merged.values()).sort((a, b) => Number(b.id) - Number(a.id)); hasMore.value = data.hasMore; } catch (error) { console.error(error); refreshError.value = true; } finally { loadingMore.value = false; } };
  const updateSearchUrl = (value) => { const params = new URLSearchParams(window.location.search); if (value) params.set('search', value); else params.delete('search'); const query = params.toString(); history.pushState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}`); };
  const applyFilter = async () => { searchInProgress = true; refreshGeneration++; activeFilter.value = filter.value.trim(); updateSearchUrl(activeFilter.value); jobs.value = []; hasMore.value = false; try { await refreshJobs(true); } finally { searchInProgress = false; refreshPending = false; } };
  const clearFilter = async () => { searchInProgress = true; refreshGeneration++; filter.value = ''; activeFilter.value = ''; updateSearchUrl(''); jobs.value = []; hasMore.value = false; try { await refreshJobs(true); } finally { searchInProgress = false; refreshPending = false; } };
  const setFilter = (event) => { filter.value = event.target.value; };
  onInit(() => { const initialSearch = new URLSearchParams(window.location.search).get('search')?.trim() || ''; filter.value = initialSearch; activeFilter.value = initialSearch; if (notificationsSupported.value) navigator.serviceWorker.register('/service-worker.js').then(() => { if (notificationsEnabled.value) void enablePushNotifications(); }).catch((error) => console.error('Service worker registration failed', error)); eventSource = new EventSource('/api/events'); eventSource.addEventListener('jobs.available', refreshJobs); eventSource.addEventListener('jobs.changed', refreshJobs); eventSource.onerror = () => { refreshError.value = true; }; void refreshJobs(); refreshTimer = setInterval(refreshJobs, 60000); });
  onDestroy(() => { eventSource?.close(); clearInterval(refreshTimer); });
  return { jobs, refreshError, hasMore, loadingMore, filter, activeFilter, pushConfigured, setFilter, loadMore, applyFilter, clearFilter, upper, notificationsSupported, notificationsEnabled, notificationNotice, toggleNotifications };
}
