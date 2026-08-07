let baseURL = process.env.DATABASE_URL;
let pragmas: string[] = [];

async function query(
  method: 'get' | 'run' | 'all',
  statement: string,
  data?: Array<string | number | null>,
  pragma = pragmas,
) {
  let req;
  let error;
  let retries = 1;
  let max = 3;

  while (retries < max) {
    try {
      req = await fetch(new URL('/query', baseURL), {
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

      await new Promise((r) => setTimeout(r, retries++ * 1000));
    } catch (e) {
      error = e;
    }
  }

  throw new Error(error || (await req.text()));
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

export function setUrl(u) {
  baseURL = u;
}
