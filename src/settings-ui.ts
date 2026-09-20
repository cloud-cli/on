import template from './settings-ui.html?raw';

export function generateSettingsHtml(page: 'tokens' | 'notifications' | 'workers' = 'tokens'): string {
  return template.replace('__SETTINGS_PAGE__', page);
}
