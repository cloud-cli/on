const empty = async () => [];

export const get = empty;
export const run = empty;
export const all = empty;
export const exec = empty;
export const pragma = () => undefined;
export const transaction = empty;
export const schema = empty;
export const clone = empty;

export default { get, run, all, exec, pragma, transaction, schema, clone };
