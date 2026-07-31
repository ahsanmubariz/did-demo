import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { DID } from '../src/wallet/did-profile';
import { startPublisher } from './server';

async function main() {
  const pairingToken = randomBytes(32).toString('base64url');
  const stateFile = resolve(process.cwd(), '.data/did.json');
  const publisher = await startPublisher({
    host: '127.0.0.1',
    port: 8787,
    stateFile,
    pairingToken,
  });

  console.log('DID Publisher ready');
  console.log(`Local origin: ${publisher.origin}`);
  console.log(`Public DID: ${DID}`);
  console.log(`State file: ${stateFile}`);
  console.log(`Pairing token: ${pairingToken}`);

  let closing = false;
  async function close() {
    if (closing) return;
    closing = true;
    await publisher.close();
    process.exitCode = 0;
  }
  process.once('SIGINT', () => void close());
  process.once('SIGTERM', () => void close());
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
