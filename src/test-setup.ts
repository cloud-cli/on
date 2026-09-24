import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ||= fileURLToPath(new URL('./test-db.mjs', import.meta.url));
