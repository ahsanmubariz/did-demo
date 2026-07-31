/** @jest-environment node */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { p256 } from '@noble/curves/nist.js';
import {
  verifyAuthorizationRequest,
} from '../src/credentials/authorization-request';
import { createCredentialProof } from '../src/credentials/issuance';
import {
  createEmployeePresentation,
  RP_CLIENT_ID,
  rpDisclosedClaimNames,
  type IssuedEmployeeCredential,
} from '../src/credentials/sd-jwt';
import {
  buildDidDocument,
  publicJwkFromUncompressed,
} from '../src/wallet/did-profile';
import { startCompanion, type RunningCompanion } from './server';

async function issueCredential(
  origin: string,
  holderSecret: Uint8Array,
  operatorToken: string,
): Promise<IssuedEmployeeCredential> {
  const holderDocument = buildDidDocument(
    publicJwkFromUncompressed(p256.getPublicKey(holderSecret, false)),
  );
  await fetch(`${origin}/api/did`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${operatorToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(holderDocument),
  });
  const created = (await (
    await fetch(`${origin}/api/operator/offers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${operatorToken}` },
    })
  ).json()) as { credentialOfferUri: string; transactionCode: string };
  const offer = (await (await fetch(created.credentialOfferUri)).json()) as {
    grants: Record<string, { 'pre-authorized_code': string }>;
  };
  const preAuthorizedCode =
    offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code']![
      'pre-authorized_code'
    ];
  const token = (await (
    await fetch(`${origin}/oid4vci/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
        'pre-authorized_code': preAuthorizedCode,
        tx_code: created.transactionCode,
      }),
    })
  ).json()) as { access_token: string };
  const nonce = (await (
    await fetch(`${origin}/oid4vci/nonce`, { method: 'POST' })
  ).json()) as { c_nonce: string };
  const issued = (await (
    await fetch(`${origin}/oid4vci/credential`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        credential_configuration_id: 'EmployeeCredential',
        proof: {
          proof_type: 'jwt',
          jwt: createCredentialProof({
            secretKey: holderSecret,
            keyId: holderDocument.authentication[0],
            audience: origin,
            nonce: nonce.c_nonce,
            now: Math.floor(Date.now() / 1000),
          }),
        },
      }),
    })
  ).json()) as { credentials: Array<{ credential: string }> };
  const compact = issued.credentials[0]!.credential;
  return {
    compact,
    disclosures: compact.split('~').slice(1, -1),
  };
}

describe('OpenID4VP partner access seam', () => {
  let stateDirectory: string;
  let companion: RunningCompanion | undefined;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'credential-presentation-'));
  });

  afterEach(async () => {
    await companion?.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  test('grants only the bound browser after exact selective disclosure', async () => {
    const holderSecret = Uint8Array.from([...new Uint8Array(31), 3]);
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      operatorToken: 'operator-secret',
    });
    const credential = await issueCredential(
      companion.origin,
      holderSecret,
      'operator-secret',
    );

    const created = await fetch(`${companion.origin}/api/rp/requests`, {
      method: 'POST',
    });
    expect(created.status).toBe(201);
    const browserCookie = created.headers.get('set-cookie')!;
    expect(browserCookie).toContain('HttpOnly');
    expect(browserCookie).toContain('SameSite=Lax');
    const requestReference = (await created.json()) as {
      id: string;
      requestUri: string;
    };
    const requestJwt = await (await fetch(requestReference.requestUri)).text();
    const rpDocument = (await (
      await fetch(`${companion.origin}/rp/did.json`)
    ).json()) as {
      verificationMethod: Array<{ publicKeyJwk: Parameters<typeof verifyAuthorizationRequest>[0]['rpJwk'] }>;
    };
    const requestObject = verifyAuthorizationRequest({
      jwt: requestJwt,
      rpJwk: rpDocument.verificationMethod[0]!.publicKeyJwk,
      expectedAudience: 'https://self-issued.me/v2',
      now: Math.floor(Date.now() / 1000),
    });
    expect(requestObject.clientId).toBe(RP_CLIENT_ID);
    expect(requestObject.claims).toEqual([...rpDisclosedClaimNames]);

    const presentation = createEmployeePresentation({
      credential,
      holderSecret,
      audience: RP_CLIENT_ID,
      nonce: requestObject.nonce,
      now: Math.floor(Date.now() / 1000),
      disclose: [...rpDisclosedClaimNames],
    });
    const submitted = await fetch(requestObject.responseUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        state: requestObject.state,
        vp_token: presentation,
      }),
    });
    expect(submitted.status).toBe(200);

    expect(
      (
        await fetch(
          `${companion.origin}/api/rp/requests/${requestReference.id}`,
        )
      ).status,
    ).toBe(403);
    const result = await fetch(
      `${companion.origin}/api/rp/requests/${requestReference.id}`,
      { headers: { Cookie: browserCookie } },
    );
    expect(await result.json()).toEqual({
      state: 'granted',
      disclosed: {
        name: 'Alya Pratama',
        employer: 'PERURI',
        employment_status: 'active',
      },
      accessExpiresIn: expect.any(Number),
    });

    await fetch(`${companion.origin}/api/operator/credentials/active/revoke`, {
      method: 'POST',
      headers: { Authorization: 'Bearer operator-secret' },
    });
    const afterRevocation = (await (
      await fetch(`${companion.origin}/api/rp/requests`, { method: 'POST' })
    ).json()) as { requestUri: string };
    const revokedRequestJwt = await (
      await fetch(afterRevocation.requestUri)
    ).text();
    const revokedRequest = verifyAuthorizationRequest({
      jwt: revokedRequestJwt,
      rpJwk: rpDocument.verificationMethod[0]!.publicKeyJwk,
      expectedAudience: 'https://self-issued.me/v2',
      now: Math.floor(Date.now() / 1000),
    });
    const revokedPresentation = createEmployeePresentation({
      credential,
      holderSecret,
      audience: RP_CLIENT_ID,
      nonce: revokedRequest.nonce,
      now: Math.floor(Date.now() / 1000),
      disclose: [...rpDisclosedClaimNames],
    });
    const deniedAfterRevocation = await fetch(revokedRequest.responseUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        state: revokedRequest.state,
        vp_token: revokedPresentation,
      }),
    });
    expect(deniedAfterRevocation.status).toBe(400);
    expect(await deniedAfterRevocation.json()).toEqual({
      error: 'credential_not_active',
    });
  });

  test('records a wallet denial without leaking credential details', async () => {
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      operatorToken: 'operator-secret',
    });
    const created = await fetch(`${companion.origin}/api/rp/requests`, {
      method: 'POST',
    });
    const cookie = created.headers.get('set-cookie')!;
    const reference = (await created.json()) as { id: string; requestUri: string };
    const requestJwt = await (await fetch(reference.requestUri)).text();
    const payload = JSON.parse(
      new TextDecoder().decode(
        Buffer.from(requestJwt.split('.')[1]!, 'base64url'),
      ),
    ) as { state: string; response_uri: string };

    expect(
      (
        await fetch(payload.response_uri, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            state: payload.state,
            error: 'access_denied',
          }),
        })
      ).status,
    ).toBe(200);
    expect(
      await (
        await fetch(`${companion.origin}/api/rp/requests/${reference.id}`, {
          headers: { Cookie: cookie },
        })
      ).json(),
    ).toEqual({ state: 'denied', reason: 'Wallet holder declined this request.' });
  });

  test('rate limits repeated presentation-session creation', async () => {
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      operatorToken: 'operator-secret',
    });
    const statuses: number[] = [];
    for (let index = 0; index < 21; index += 1) {
      statuses.push(
        (
          await fetch(`${companion.origin}/api/rp/requests`, {
            method: 'POST',
          })
        ).status,
      );
    }
    expect(statuses.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 201));
    expect(statuses[20]).toBe(429);
  });
});
