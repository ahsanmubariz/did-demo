/** @jest-environment node */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startPublisher, type RunningPublisher } from '../../publisher/server';
import { HttpPublisherClient } from '../adapters/publisher-client';
import {
  DidControllerWallet,
  type RandomSource,
  type SecretStore,
} from './capability';
import { DID } from './did-profile';

class MemorySecrets implements SecretStore {
  readonly values = new Map<string, string>();

  async get(key: string) {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string) {
    this.values.set(key, value);
  }

  async delete(key: string) {
    this.values.delete(key);
  }
}

class DeterministicRandom implements RandomSource {
  private sequence = 1;

  async bytes(length: number) {
    const seed = this.sequence++;
    return Uint8Array.from({ length }, (_, index) => (seed * 31 + index * 17) % 256);
  }
}

class FlakyPublisher {
  failNextResolve = false;

  constructor(private readonly client: HttpPublisherClient) {}

  publish(...args: Parameters<HttpPublisherClient['publish']>) {
    return this.client.publish(...args);
  }

  resolve() {
    if (this.failNextResolve) {
      this.failNextResolve = false;
      throw new Error('simulated resolution outage');
    }
    return this.client.resolve();
  }

  reset(...args: Parameters<HttpPublisherClient['reset']>) {
    return this.client.reset(...args);
  }
}

describe('DID Controller Wallet capability seam', () => {
  let directory: string;
  let publisher: RunningPublisher;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'did-wallet-'));
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile: join(directory, 'did.json'),
      pairingToken: 'pair-once',
    });
  });

  afterEach(async () => {
    await publisher.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('pairs, creates, publishes, resolves, and proves control end to end', async () => {
    const wallet = new DidControllerWallet({
      secrets: new MemorySecrets(),
      random: new DeterministicRandom(),
      publisher: new HttpPublisherClient(publisher.origin),
      clock: { nowSeconds: () => 1785373200 },
    });

    await wallet.pair('pair-once');
    await wallet.createIdentity();
    await wallet.publish();
    await wallet.resolve();
    await wallet.proveControl();

    expect(wallet.snapshot()).toMatchObject({
      did: DID,
      paired: true,
      hasIdentity: true,
      published: true,
      resolved: true,
      proven: true,
    });

    const publicDocument = await (
      await fetch(`${publisher.origin}/.well-known/did.json`)
    ).json();
    expect(publicDocument).toEqual(wallet.snapshot().didDocument);
    expect(wallet.snapshot().proof?.split('.')).toHaveLength(3);
  });

  test('rotates to a new proven key without changing the DID', async () => {
    const wallet = new DidControllerWallet({
      secrets: new MemorySecrets(),
      random: new DeterministicRandom(),
      publisher: new HttpPublisherClient(publisher.origin),
      clock: { nowSeconds: () => 1785373200 },
    });
    await wallet.pair('pair-once');
    await wallet.createIdentity();
    await wallet.publish();
    await wallet.resolve();
    await wallet.proveControl();
    const previousKeyId = wallet.snapshot().keyId;

    await wallet.rotate();

    expect(wallet.snapshot()).toMatchObject({
      did: DID,
      published: true,
      resolved: true,
      proven: true,
    });
    expect(wallet.snapshot().keyId).not.toBe(previousKeyId);
    expect(
      (
        (await (
          await fetch(`${publisher.origin}/.well-known/did.json`)
        ).json()) as { authentication: string[] }
      ).authentication[0],
    ).toBe(wallet.snapshot().keyId);
  });

  test('rolls back local and public authority when rotation validation fails', async () => {
    const client = new FlakyPublisher(new HttpPublisherClient(publisher.origin));
    const wallet = new DidControllerWallet({
      secrets: new MemorySecrets(),
      random: new DeterministicRandom(),
      publisher: client,
      clock: { nowSeconds: () => 1785373200 },
    });
    await wallet.pair('pair-once');
    await wallet.createIdentity();
    await wallet.publish();
    await wallet.resolve();
    await wallet.proveControl();
    const previousKeyId = wallet.snapshot().keyId;
    client.failNextResolve = true;

    await expect(wallet.rotate()).rejects.toMatchObject({ code: 'rotation_failed' });

    expect(wallet.snapshot().keyId).toBe(previousKeyId);
    expect((await client.resolve()).authentication[0]).toBe(previousKeyId);
  });
});
