import fs from 'node:fs';
import { Writable } from 'node:stream';

/** Writes complete output lines with an ISO-8601 timestamp prefix. */
export class TimestampedLogWriter extends Writable {
  private pending = '';

  constructor(private readonly fd: number) {
    super();
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.pending += chunk.toString();
    let newlineIndex = this.pending.indexOf('\n');
    let output = '';

    while (newlineIndex !== -1) {
      output += `[${new Date().toISOString()}] ${this.pending.slice(0, newlineIndex + 1)}`;
      this.pending = this.pending.slice(newlineIndex + 1);
      newlineIndex = this.pending.indexOf('\n');
    }

    this.writeOutput(output, callback);
  }

  override _final(callback: (error?: Error | null) => void) {
    const output = this.pending ? `[${new Date().toISOString()}] ${this.pending}` : '';
    this.pending = '';
    this.writeOutput(output, callback);
  }

  private writeOutput(output: string, callback: (error?: Error | null) => void) {
    if (!output) {
      callback();
      return;
    }

    fs.write(this.fd, output, 0, 'utf8', (error) => callback(error));
  }
}
