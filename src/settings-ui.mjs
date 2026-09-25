
         import { onInit, ref } from '@li3/web';
         import { apiFetch, setApiToken } from '@app/api-client.mjs';
        export default function () {
          const page = document.body.dataset.page;
           const keys = ref([]);
           const workers = ref([]);
          const keyName = ref('');
          const newToken = ref('');
          const error = ref('');
          const notificationsSupported = ref('Notification' in window && 'serviceWorker' in navigator);
          const notificationsEnabled = ref(notificationsSupported.value && Notification.permission === 'granted' && localStorage.getItem('runner-notifications') === 'enabled');
          const notificationMessage = ref('');
          const scopeOptions = ref([
            { name: 'workflows:read', label: 'Read workflows', selected: true },
            { name: 'workflows:write', label: 'Modify workflows', selected: false },
            { name: 'logs:read', label: 'Read logs', selected: false },
            { name: 'artifacts:read', label: 'Read artifacts', selected: false },
            { name: 'runs:control', label: 'Control runs', selected: false },
            { name: 'runs:dispatch', label: 'Dispatch runs', selected: false },
          ]);
           const api = async (url, options = {}) => { const response = await apiFetch(url, { headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}) }, ...options }); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`); return body; };
           const load = async () => { keys.value = (await api('/api/api-keys')).keys; };
           const loadWorkers = async () => { workers.value = (await api('/api/workers')).workers; };
           const issueKey = async () => { try { error.value = ''; const result = await api('/api/api-keys', { method: 'POST', body: JSON.stringify({ name: keyName.value, scopes: scopeOptions.value.filter((scope) => scope.selected).map((scope) => scope.name) }) }); newToken.value = result.token; setApiToken(result.token); keyName.value = ''; await load(); } catch (reason) { error.value = reason.message; } };
          const revokeKey = async (key) => { if (!confirm(`Revoke ${key.name}?`)) return; try { await api(`/api/api-keys/${key.id}`, { method: 'DELETE' }); await load(); } catch (reason) { error.value = reason.message; } };
          const setKeyName = (event) => { keyName.value = event.target.value; };
          const toggleScope = (scope) => { scope.selected = !scope.selected; };
          const toggleNotifications = async () => {
            if (notificationsEnabled.value) {
              notificationsEnabled.value = false;
              localStorage.removeItem('runner-notifications');
              notificationMessage.value = 'Notifications disabled on this device.';
              return;
            }
            if (!notificationsSupported.value) { notificationMessage.value = 'Notifications are not supported by this browser.'; return; }
            const permission = await Notification.requestPermission();
            notificationsEnabled.value = permission === 'granted';
            if (notificationsEnabled.value) { localStorage.setItem('runner-notifications', 'enabled'); notificationMessage.value = 'Notifications enabled.'; }
            else notificationMessage.value = 'Notification permission was not granted.';
          };
          onInit(() => { if (page === 'tokens') load().catch((reason) => { error.value = reason.message; }); if (page === 'workers') loadWorkers().catch((reason) => { error.value = reason.message; }); });
          return { page, keys, workers, keyName, newToken, error, scopeOptions, issueKey, revokeKey, setKeyName, toggleScope, notificationsEnabled, notificationMessage, toggleNotifications };
        }
      
