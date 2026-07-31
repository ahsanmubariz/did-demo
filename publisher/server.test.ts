/** @jest-environment node */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDidDocument } from '../src/wallet/did-profile';
import { startPublisher, type RunningPublisher } from './server';

const didDocument = buildDidDocument({
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  alg: 'ES256',
  use: 'sig',
});

describe('DID Publisher HTTP seam', () => {
  let directory: string;
  let publisher: RunningPublisher | undefined;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'did-publisher-'));
  });

  afterEach(async () => {
    await publisher?.close();
    await rm(directory, { recursive: true, force: true });
  });

  test('reports healthy absent state before a document is published', async () => {
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile: join(directory, 'did.json'),
      pairingToken: 'test-pairing-token',
    });

    const response = await fetch(`${publisher.origin}/healthz`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ status: 'ok', document: 'absent' });
  });

  test('reports the public DID document as unpublished', async () => {
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile: join(directory, 'did.json'),
      pairingToken: 'test-pairing-token',
    });

    const response = await fetch(`${publisher.origin}/.well-known/did.json`);

    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(await response.json()).toEqual({
      error: 'not_found',
      message: 'No DID document has been published',
    });
  });

  test('requires the process pairing token before publishing', async () => {
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile: join(directory, 'did.json'),
      pairingToken: 'test-pairing-token',
    });

    const response = await fetch(`${publisher.origin}/api/did`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'pairing_required',
      message: 'Enter the current Publisher pairing token',
    });
  });

  test('rejects unsupported methods on known paths with a stable error', async () => {
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile: join(directory, 'did.json'),
      pairingToken: 'test-pairing-token',
    });

    const response = await fetch(`${publisher.origin}/healthz`, {
      method: 'POST',
    });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(await response.json()).toEqual({
      error: 'method_not_allowed',
      message: 'Method not allowed for this route',
    });
  });

  test('reports persistence failures without mislabeling a valid document', async () => {
    const blockedParent = join(directory, 'blocked');
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile: join(blockedParent, 'did.json'),
      pairingToken: 'test-pairing-token',
    });
    await writeFile(blockedParent, 'not a directory');

    const response = await fetch(`${publisher.origin}/api/did`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-pairing-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(didDocument),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: 'persistence_error',
      message: 'Publisher state could not be saved',
    });
  });

  test('publishes and publicly resolves an authorized DID document', async () => {
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile: join(directory, 'did.json'),
      pairingToken: 'test-pairing-token',
    });

    const publish = await fetch(`${publisher.origin}/api/did`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-pairing-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(didDocument),
    });
    expect(publish.status).toBe(204);

    const resolved = await fetch(`${publisher.origin}/.well-known/did.json`);
    expect(resolved.status).toBe(200);
    expect(resolved.headers.get('content-type')).toBe(
      'application/did+ld+json; charset=utf-8',
    );
    expect(resolved.headers.get('cache-control')).toBe('no-store');
    expect(resolved.headers.get('access-control-allow-origin')).toBe('*');
    expect(await resolved.json()).toEqual(didDocument);

    const health = await fetch(`${publisher.origin}/healthz`);
    expect(await health.json()).toEqual({ status: 'ok', document: 'present' });
  });

  test('restores the public document while invalidating the previous process token', async () => {
    const stateFile = join(directory, 'did.json');
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile,
      pairingToken: 'first-token',
    });
    await fetch(`${publisher.origin}/api/did`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer first-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(didDocument),
    });
    await publisher.close();

    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile,
      pairingToken: 'second-token',
    });

    const resolved = await fetch(`${publisher.origin}/.well-known/did.json`);
    expect(await resolved.json()).toEqual(didDocument);

    const oldToken = await fetch(`${publisher.origin}/api/did`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer first-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(didDocument),
    });
    expect(oldToken.status).toBe(401);
  });

  test('removes the public document through an authorized idempotent reset', async () => {
    const stateFile = join(directory, 'did.json');
    publisher = await startPublisher({
      host: '127.0.0.1',
      port: 0,
      stateFile,
      pairingToken: 'test-pairing-token',
    });
    await fetch(`${publisher.origin}/api/did`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer test-pairing-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(didDocument),
    });

    const reset = await fetch(`${publisher.origin}/api/did`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-pairing-token' },
    });
    const resetAgain = await fetch(`${publisher.origin}/api/did`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer test-pairing-token' },
    });

    expect(reset.status).toBe(204);
    expect(resetAgain.status).toBe(204);
    expect((await fetch(`${publisher.origin}/.well-known/did.json`)).status).toBe(404);
  });
});
