const baseURL = process.env.DATABASE_HTTP_URL;

async function query(method, statement, data, pragma, transaction) {
  const response = await fetch(new URL('/query', baseURL), {
    method: 'POST',
    body: JSON.stringify({ s: statement, d: data, m: method, p: pragma, t: transaction }),
  });
  if (response.ok) return response.json();
  throw new Error(await response.text());
}

export const get = query.bind(null, 'get');
export const run = query.bind(null, 'run');
export const all = query.bind(null, 'all');
export const exec = query.bind(null, 'exec');
export const pragma = () => undefined;
export const transaction = (statements, pragma) => query('transaction', undefined, undefined, pragma, statements);
export const schema = async () => [];
export const clone = async () => undefined;

export default { get, run, all, exec, pragma, transaction, schema, clone };
