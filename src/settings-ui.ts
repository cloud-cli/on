import template from "./settings-ui.html?raw";

export function generateSettingsHtml(): string {
  return template.replace("__SETTINGS_PAGE__", "settings");
}
