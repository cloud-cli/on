const baseURL = process.env.DATABASE_URL;

let pragmas = [];

async function query(method, statement, data, pragma = pragmas) {
  const req = await fetch(new URL('/query', baseURL), {
    method: 'POST',
    body: JSON.stringify({
      s: statement,
      d: data,
      m: method,
      p: pragma,
    }),
  });

  if (req.ok) {
    return await req.json();
  }

  throw new Error(await req.text());
}

export const get = query.bind(null, 'get');
export const run = query.bind(null, 'run');
export const all = query.bind(null, 'all');

export function pragma(p) {
  if (Array.isArray(p) && p.every((s) => typeof s === 'string')) {
    pragmas = p;
  }
}

export default { query, get, run, all, pragma };
