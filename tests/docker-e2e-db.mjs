const unexpectedQuery = async () => {
  throw new Error("This Docker workflow test must not use a database");
};

export const get = unexpectedQuery;
export const run = unexpectedQuery;
export const all = unexpectedQuery;
export const exec = unexpectedQuery;
export const pragma = () => undefined;
export const schema = async () => [];
export const clone = async () => undefined;
export default { get, run, all, exec, pragma, schema, clone };
