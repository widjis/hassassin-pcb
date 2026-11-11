/**
 * hassassin-server [--port 5179] [--host 127.0.0.1] [--data ./.data] [--static ./apps/web/dist]
 */
import { resolve } from 'node:path';
import { startServer } from './server.ts';

const args = process.argv.slice(2);
const opt = (name: string, d: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};

const s = await startServer({
  port: Number(opt('port', process.env.PORT ?? '5179')),
  host: opt('host', process.env.HOST ?? '127.0.0.1'),
  dataDir: resolve(opt('data', process.env.HASSASSIN_DATA ?? '.data')),
  ...(args.includes('--static') ? { staticDir: resolve(opt('static', 'apps/web/dist')) } : {}),
  log: (m) => console.log(`[${new Date().toISOString()}] ${m}`),
});
console.log(`Hassassin collaboration server on http://${opt('host', '127.0.0.1')}:${s.port}`);
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => s.close().then(() => process.exit(0)));
