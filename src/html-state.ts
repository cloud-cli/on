export function serializeHtmlState(state: Record<string, unknown>): string {
  return JSON.stringify(state).replace(/[<>&\u2028\u2029]/g, (character) => {
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}
