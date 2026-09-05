const debugEnabled = !!process.env.DEBUG;

export function debug(...args) {
  debugEnabled && console.log(...args);
}
