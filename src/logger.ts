import { format } from 'node:util';
import { timestampLogLines } from './timestamped-log.js';

type ConsoleMethod = 'log' | 'info' | 'warn' | 'error';

export function installTimestampedConsole(): void {
  for (const method of ['log', 'info', 'warn', 'error'] as ConsoleMethod[]) {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      original(timestampLogLines(format(...args)));
    }) as typeof console[typeof method];
  }
}
