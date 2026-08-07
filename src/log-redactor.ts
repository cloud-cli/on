import { Transform, TransformCallback } from 'node:stream';

export class SecretRedactorStream extends Transform {
  private secretValues: string[];

  constructor(secretValues: string[]) {
    super();
    // Sort longest secrets first to prevent partial replacements
    this.secretValues = secretValues.sort((a, b) => b.length - a.length);
  }

  _transform(chunk: any, _encoding: BufferEncoding, callback: TransformCallback) {
    let logString = chunk.toString('utf-8');

    // Replace all known secret values with ***
    for (const secret of this.secretValues) {
      if (secret) {
        logString = logString.replaceAll(secret, '***');
      }
    }

    this.push(Buffer.from(logString));
    callback();
  }
}
