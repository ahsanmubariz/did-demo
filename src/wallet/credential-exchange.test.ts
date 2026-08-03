import type { CredentialVault, StoredCredential } from './credential-vault';
import { CredentialExchangeWallet } from './credential-exchange';
import { createAuthorizationRequest } from '../credentials/authorization-request';
import { ISSUER_DID, RP_DID } from '../credentials/sd-jwt';
import { p256 } from '@noble/curves/nist.js';
import { publicJwkFromUncompressed } from './did-profile';
import { createStatusListToken } from '../credentials/status-list';
import { base64urlnopad } from '@scure/base';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const activeCredential: StoredCredential = {
  id: 'employee-001',
  compact: 'issuer~disclosure~',
  issuer: 'DUMMY-CORP Demo Issuer',
  type: 'Employee Credential',
  issuedAt: 1785373200,
  expiresAt: 1785978000,
  status: 'active',
};

describe('wallet credential acceptance seam', () => {
  test('acknowledges only after encrypted persistence succeeds', async () => {
    const events: string[] = [];
    const requests: { url: string; init?: RequestInit }[] = [];
    const fetcher = jest.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith('/offer')) {
        return jsonResponse({
          credential_issuer: 'https://issuer.test',
          credential_configuration_ids: ['EmployeeCredential'],
          grants: {
            'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
              'pre-authorized_code': 'pre-authorized',
              tx_code: { input_mode: 'numeric', length: 6 },
            },
          },
        });
      }
      if (url.endsWith('/.well-known/openid-credential-issuer')) {
        return jsonResponse({
          credential_issuer: 'https://issuer.test',
          token_endpoint: 'https://issuer.test/token',
          credential_endpoint: 'https://issuer.test/credential',
          nonce_endpoint: 'https://issuer.test/nonce',
          notification_endpoint: 'https://issuer.test/notification',
        });
      }
      if (url.endsWith('/token')) {
        return jsonResponse({ access_token: 'access' });
      }
      if (url.endsWith('/nonce')) return jsonResponse({ c_nonce: 'fresh' });
      if (url.endsWith('/credential')) {
        return jsonResponse({
          credentials: [{ credential: 'issuer~disclosure~' }],
          notification_id: 'notification-1',
        });
      }
      if (url.endsWith('/notification')) {
        events.push('notified');
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ error: 'not_found' }, 404);
    });
    const vault = {
      save: jest.fn(async (_credential: StoredCredential) => {
        events.push('persisted');
      }),
    } as unknown as CredentialVault;
    const wallet = new CredentialExchangeWallet({
      fetch: fetcher,
      vault,
      identity: {
        createCredentialProof: () => 'holder-proof',
      },
      clock: { nowSeconds: () => 1785373200 },
    });

    const result = await wallet.acceptOffer('https://issuer.test/offer', '123456');

    expect(result.compact).toBe('issuer~disclosure~');
    expect(events).toEqual(['persisted', 'notified']);
    expect(
      JSON.parse(
        String(requests.find(({ url }) => url.endsWith('/credential'))?.init?.body),
      ),
    ).toMatchObject({ proof: { jwt: 'holder-proof' } });
  });

  test('does not acknowledge when vault persistence fails', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          credential_issuer: 'https://issuer.test',
          credential_configuration_ids: ['EmployeeCredential'],
          grants: {
            'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
              'pre-authorized_code': 'pre',
              tx_code: { input_mode: 'numeric', length: 6 },
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          credential_issuer: 'https://issuer.test',
          token_endpoint: 'https://issuer.test/token',
          credential_endpoint: 'https://issuer.test/credential',
          nonce_endpoint: 'https://issuer.test/nonce',
          notification_endpoint: 'https://issuer.test/notification',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ access_token: 'access' }))
      .mockResolvedValueOnce(jsonResponse({ c_nonce: 'fresh' }))
      .mockResolvedValueOnce(
        jsonResponse({
          credentials: [{ credential: 'issuer~disclosure~' }],
          notification_id: 'notification-1',
        }),
      );
    const wallet = new CredentialExchangeWallet({
      fetch: fetcher,
      vault: {
        save: async () => {
          throw new Error('sqlite_write_failed');
        },
      } as unknown as CredentialVault,
      identity: { createCredentialProof: () => 'proof' },
      clock: { nowSeconds: () => 1785373200 },
    });

    await expect(
      wallet.acceptOffer('https://issuer.test/offer', '123456'),
    ).rejects.toThrow('sqlite_write_failed');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  test('verifies the RP request before applying explicit consent', async () => {
    const rpSecret = Uint8Array.from([...new Uint8Array(31), 4]);
    const rpJwk = publicJwkFromUncompressed(
      p256.getPublicKey(rpSecret, false),
    );
    const requestJwt = createAuthorizationRequest({
      rpSecret,
      rpKeyId: `${RP_DID}#demo`,
      responseUri: 'https://rp.test/oid4vp/direct_post',
      nonce: 'request-nonce',
      state: 'request-state',
      now: 1785373200,
    });
    const bodies: string[] = [];
    const wallet = new CredentialExchangeWallet({
      fetch: async (url, init) => {
        if (url.endsWith('/rp/requests/one')) return new Response(requestJwt);
        if (url.endsWith('/rp/did.json')) {
          return jsonResponse({
            verificationMethod: [{ publicKeyJwk: rpJwk }],
          });
        }
        bodies.push(String(init?.body));
        return jsonResponse({ redirect_uri: 'https://rp.test/partner/result/one' });
      },
      vault: { save: async () => undefined } as unknown as CredentialVault,
      identity: new (class {
        private readonly signingCapability = 'selective-presentation';

        createCredentialProof() {
          return 'proof';
        }

        createEmployeePresentation() {
          return this.signingCapability;
        }
      })(),
      clock: { nowSeconds: () => 1785373200 },
      trustedOrigin: 'https://rp.test',
    });

    const request = await wallet.inspectPresentationRequest(
      'https://rp.test/rp/requests/one',
    );
    expect(request.claims).toEqual(['name', 'employer', 'employment_status']);
    await wallet.respondToPresentation(request, activeCredential, true);
    expect(new URLSearchParams(bodies[0]).get('vp_token')).toBe(
      'selective-presentation',
    );
  });

  test('refreshes a revoked status through the signed online list', async () => {
    const issuerSecret = Uint8Array.from([...new Uint8Array(31), 7]);
    const issuerJwk = publicJwkFromUncompressed(
      p256.getPublicKey(issuerSecret, false),
    );
    const origin = 'https://wallet.example.test';
    const statusUri = `${origin}/status/employee`;
    const token = createStatusListToken({
      issuerSecret,
      issuerKeyId: `${ISSUER_DID}#status`,
      uri: statusUri,
      statuses: [true],
      now: 1785373200,
    });
    const payload = base64urlnopad.encode(
      new TextEncoder().encode(
        JSON.stringify({ status: { status_list: { idx: 0, uri: statusUri } } }),
      ),
    );
    const stored = {
      ...activeCredential,
      compact: `e30.${payload}.sig~disclosure~`,
    };
    const save = jest.fn();
    const wallet = new CredentialExchangeWallet({
      fetch: async (url) =>
        url.endsWith('/status/employee')
          ? new Response(token)
          : jsonResponse({ verificationMethod: [{ publicKeyJwk: issuerJwk }] }),
      vault: { save },
      identity: { createCredentialProof: () => 'proof' },
      clock: { nowSeconds: () => 1785373201 },
      trustedOrigin: origin,
    });

    expect(await wallet.refreshCredentialStatus(stored)).toMatchObject({
      status: 'revoked',
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ status: 'revoked' }));
  });
});
