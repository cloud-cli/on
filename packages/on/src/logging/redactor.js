import { Transform } from 'node:stream';
export class SecretRedactorStream extends Transform {
    secretValues;
    constructor(secretValues) {
        super();
        // Sort longest secrets first to prevent partial replacements
        this.secretValues = secretValues.sort((a, b) => b.length - a.length);
    }
    _transform(chunk, encoding, callback) {
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
//# sourceMappingURL=redactor.js.map