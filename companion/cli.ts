import { resolve } from 'node:path';
import { startCompanion } from './server';

function requiredEnvironment(
  name:
    | 'PUBLIC_ORIGIN'
    | 'EXPO_PUBLIC_COMPANION_ORIGIN'
    | 'OPERATOR_TOKEN',
): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured in .env`);
  return value;
}

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '0.0.0.0';
const publicOrigin = requiredEnvironment('PUBLIC_ORIGIN');
const mobileOrigin = requiredEnvironment('EXPO_PUBLIC_COMPANION_ORIGIN');
const stateDirectory = resolve(process.env.STATE_DIRECTORY ?? '.data');
const staticDirectory = resolve(process.env.STATIC_DIRECTORY ?? 'dist/web');
const operatorToken = requiredEnvironment('OPERATOR_TOKEN');

if (publicOrigin !== mobileOrigin) {
  throw new Error(
    'PUBLIC_ORIGIN and EXPO_PUBLIC_COMPANION_ORIGIN must match',
  );
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}

async function main() {
  const companion = await startCompanion({
    host,
    port,
    publicOrigin,
    stateDirectory,
    staticDirectory,
    operatorToken,
  });

  console.log(`Credential Exchange Demo listening locally at ${companion.origin}`);
  console.log('Public origin: loaded from .env');
  console.log('Operator token: loaded from .env');
  console.log(`Forward the configured HTTPS origin to http://127.0.0.1:${port}`);

  async function shutdown() {
    await companion.close();
    process.exit(0);
  }

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
