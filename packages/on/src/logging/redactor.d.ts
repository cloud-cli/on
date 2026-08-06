import { Transform, TransformCallback } from 'node:stream';
export declare class SecretRedactorStream extends Transform {
    private secretValues;
    constructor(secretValues: string[]);
    _transform(chunk: any, encoding: BufferEncoding, callback: TransformCallback): void;
}
//# sourceMappingURL=redactor.d.ts.map