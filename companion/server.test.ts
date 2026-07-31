/** @jest-environment node */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EMPLOYEE_VCT, ISSUER_DID, RP_DID } from '../src/credentials/sd-jwt';
import { buildDidDocument } from '../src/wallet/did-profile';
import { startCompanion, type RunningCompanion } from './server';

const holderDocument = buildDidDocument({
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  alg: 'ES256',
  use: 'sig',
});

describe('Companion Web HTTP seam', () => {
  let stateDirectory: string;
  let companion: RunningCompanion | undefined;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'credential-companion-'));
  });

  afterEach(async () => {
    await companion?.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  test('publishes stable role identities and protected SQLite-backed state', async () => {
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      operatorToken: 'operator-secret',
    });

    const health = await fetch(`${companion.origin}/healthz`);
    expect(await health.json()).toEqual({
      status: 'ok',
      database: 'ready',
      holderDocument: 'absent',
    });

    const [issuerResponse, rpResponse, metadataResponse] = await Promise.all([
      fetch(`${companion.origin}/issuer/did.json`),
      fetch(`${companion.origin}/rp/did.json`),
      fetch(`${companion.origin}/credentials/employee/v1`),
    ]);
    const issuerDocument = await issuerResponse.json();
    const rpDocument = await rpResponse.json();
    expect(issuerDocument).toMatchObject({
      id: ISSUER_DID,
      assertionMethod: [expect.stringMatching(`${ISSUER_DID}#`)],
    });
    expect(rpDocument).toMatchObject({
      id: RP_DID,
      authentication: [expect.stringMatching(`${RP_DID}#`)],
    });
    expect(await metadataResponse.json()).toMatchObject({ vct: EMPLOYEE_VCT });
    expect(metadataResponse.headers.get('cache-control')).toBe('public, max-age=300');

    expect((await fetch(`${companion.origin}/api/operator/summary`)).status).toBe(401);
    const summary = await fetch(`${companion.origin}/api/operator/summary`, {
      headers: { Authorization: 'Bearer operator-secret' },
    });
    expect(await summary.json()).toEqual({
      issuedCredentials: 0,
      activeExchanges: 0,
      auditEvents: 0,
    });

    await companion.close();
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      operatorToken: 'new-operator-secret',
    });
    expect(await (await fetch(`${companion.origin}/issuer/did.json`)).json()).toEqual(
      issuerDocument,
    );
    expect(await (await fetch(`${companion.origin}/rp/did.json`)).json()).toEqual(
      rpDocument,
    );
  });

  test('publishes and restores the holder DID document in the same process', async () => {
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      operatorToken: 'operator-secret',
    });

    expect(
      (
        await fetch(`${companion.origin}/api/did`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(holderDocument),
        })
      ).status,
    ).toBe(401);
    const publish = await fetch(`${companion.origin}/api/did`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer operator-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(holderDocument),
    });
    expect(publish.status).toBe(204);
    expect(
      await (
        await fetch(`${companion.origin}/.well-known/did.json`)
      ).json(),
    ).toEqual(holderDocument);

    await companion.close();
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      operatorToken: 'replacement-secret',
    });
    expect(
      await (
        await fetch(`${companion.origin}/.well-known/did.json`)
      ).json(),
    ).toEqual(holderDocument);
  });

  test('serves a built SPA while preserving API not-found responses', async () => {
    const staticDirectory = join(stateDirectory, 'web');
    await mkdir(staticDirectory);
    await writeFile(
      join(staticDirectory, 'index.html'),
      '<!doctype html><title>Credential Exchange Demo</title>',
    );
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      staticDirectory,
      operatorToken: 'operator-secret',
    });

    const page = await fetch(`${companion.origin}/issuer`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Credential Exchange Demo');
    expect((await fetch(`${companion.origin}/api/unknown`)).status).toBe(404);
  });
});
