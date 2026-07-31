/** @jest-environment node */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { p256 } from '@noble/curves/nist.js';
import {
  createCredentialProof,
} from '../src/credentials/issuance';
import {
  EMPLOYEE_VCT,
} from '../src/credentials/sd-jwt';
import { verifyStatusListToken } from '../src/credentials/status-list';
import {
  buildDidDocument,
  publicJwkFromUncompressed,
} from '../src/wallet/did-profile';
import { startCompanion, type RunningCompanion } from './server';

describe('OpenID4VCI issuance seam', () => {
  let stateDirectory: string;
  let companion: RunningCompanion | undefined;

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'credential-issuance-'));
  });

  afterEach(async () => {
    await companion?.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  test('issues and acknowledges a holder-bound Employee Credential', async () => {
    const holderSecret = Uint8Array.from([...new Uint8Array(31), 2]);
    const holderDocument = buildDidDocument(
      publicJwkFromUncompressed(p256.getPublicKey(holderSecret, false)),
    );
    companion = await startCompanion({
      host: '127.0.0.1',
      port: 0,
      stateDirectory,
      operatorToken: 'operator-secret',
    });
    await fetch(`${companion.origin}/api/did`, {
      method: 'PUT',
      headers: {
        Authorization: 'Bearer operator-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(holderDocument),
    });

    const created = await fetch(`${companion.origin}/api/operator/offers`, {
      method: 'POST',
      headers: { Authorization: 'Bearer operator-secret' },
    });
    expect(created.status).toBe(201);
    const createdOffer = (await created.json()) as {
      id: string;
      credentialOfferUri: string;
      transactionCode: string;
    };
    expect(createdOffer.transactionCode).toMatch(/^\d{6}$/);

    const offer = await (
      await fetch(createdOffer.credentialOfferUri)
    ).json() as {
      credential_issuer: string;
      credential_configuration_ids: string[];
      grants: Record<string, { 'pre-authorized_code': string; tx_code: unknown }>;
    };
    expect(offer.credential_configuration_ids).toEqual(['EmployeeCredential']);
    const grant =
      offer.grants['urn:ietf:params:oauth:grant-type:pre-authorized_code'];
    expect(grant?.tx_code).toEqual({
      input_mode: 'numeric',
      length: 6,
      description: 'Enter the demo code shown separately by the issuer.',
    });

    const metadata = await (
      await fetch(`${companion.origin}/.well-known/openid-credential-issuer`)
    ).json() as {
      credential_issuer: string;
      credential_endpoint: string;
      nonce_endpoint: string;
      credential_configurations_supported: Record<string, { vct: string }>;
    };
    expect(metadata.credential_configurations_supported.EmployeeCredential?.vct).toBe(
      EMPLOYEE_VCT,
    );

    const token = await fetch(`${companion.origin}/oid4vci/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:pre-authorized_code',
        'pre-authorized_code': grant!['pre-authorized_code'],
        tx_code: createdOffer.transactionCode,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as { access_token: string };

    const nonceBody = (await (
      await fetch(metadata.nonce_endpoint, { method: 'POST' })
    ).json()) as { c_nonce: string };
    const proof = createCredentialProof({
      secretKey: holderSecret,
      keyId: holderDocument.authentication[0],
      audience: metadata.credential_issuer,
      nonce: nonceBody.c_nonce,
      now: Math.floor(Date.now() / 1000),
    });
    const issued = await fetch(metadata.credential_endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        credential_configuration_id: 'EmployeeCredential',
        proof: { proof_type: 'jwt', jwt: proof },
      }),
    });
    expect(issued.status).toBe(200);
    const issuedBody = (await issued.json()) as {
      credentials: Array<{ credential: string }>;
      notification_id: string;
    };
    expect(issuedBody.credentials[0]?.credential).toContain('~');

    const notification = await fetch(`${companion.origin}/oid4vci/notification`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        notification_id: issuedBody.notification_id,
        event: 'credential_accepted',
      }),
    });
    expect(notification.status).toBe(204);
    expect(
      (
        await fetch(`${companion.origin}/oid4vci/notification`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${tokenBody.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            notification_id: issuedBody.notification_id,
            event: 'credential_accepted',
          }),
        })
      ).status,
    ).toBe(204);
    expect(
      await (
        await fetch(`${companion.origin}/issuer/offers/${createdOffer.id}/status`)
      ).json(),
    ).toEqual({ state: 'accepted' });

    const replacementSecret = Uint8Array.from([...new Uint8Array(31), 6]);
    const replacementDocument = buildDidDocument(
      publicJwkFromUncompressed(p256.getPublicKey(replacementSecret, false)),
    );
    expect(
      (
        await fetch(`${companion.origin}/api/did`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer operator-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(replacementDocument),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await fetch(`${companion.origin}/api/operator/credentials/active/revoke`, {
          method: 'POST',
          headers: { Authorization: 'Bearer operator-secret' },
        })
      ).status,
    ).toBe(204);
    const issuerDocument = (await (
      await fetch(`${companion.origin}/issuer/did.json`)
    ).json()) as {
      verificationMethod: Array<{
        publicKeyJwk: Parameters<typeof verifyStatusListToken>[0]['issuerJwk'];
      }>;
    };
    const statusToken = await (
      await fetch(`${companion.origin}/status/employee`)
    ).text();
    expect(
      verifyStatusListToken({
        token: statusToken,
        issuerJwk: issuerDocument.verificationMethod[0]!.publicKeyJwk,
        expectedUri:
          'https://wallet.example.test/status/employee',
        now: Math.floor(Date.now() / 1000),
      }),
    ).toEqual([true]);
    expect(
      (
        await fetch(`${companion.origin}/api/did`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer operator-secret',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(replacementDocument),
        })
      ).status,
    ).toBe(204);
  });
});
