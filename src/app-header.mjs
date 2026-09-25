import { defineProp, onInit, ref } from '@li3/web';

export default function () {
  const authConfigured = ref(false);
  const authenticated = ref(false);
  const userName = ref('');
  const userPhoto = ref('');
  onInit(async () => {
    try {
      const response = await fetch('/api/auth/session');
      if (!response.ok) return;
      const session = await response.json();
      authConfigured.value = session.configured;
      authenticated.value = session.authenticated;
      userName.value = session.user?.name || session.user?.email || '';
      userPhoto.value = session.user?.photo || '';
    } catch {}
  });
  return { title: defineProp('title'), subtitle: defineProp('subtitle'), back: defineProp('back'), backLabel: defineProp('back-label'), authConfigured, authenticated, userName, userPhoto };
}
