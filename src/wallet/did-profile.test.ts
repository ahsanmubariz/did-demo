import {
  DID,
  buildDidDocument,
  jwkThumbprint,
  validateDidDocument,
  type PublicP256Jwk,
} from './did-profile';

const fixtureJwk: PublicP256Jwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  alg: 'ES256',
  use: 'sig',
};

const thumbprint = 'oKIywvGUpTVTyxMQ3bwIIeQUudfr_CkLMjCE19ECD-U';
const keyId = `${DID}#${thumbprint}`;

describe('DID document profile', () => {
  test('builds the independently specified document for a public P-256 key', () => {
    expect(jwkThumbprint(fixtureJwk)).toBe(thumbprint);
    expect(buildDidDocument(fixtureJwk)).toEqual({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/jws-2020/v1',
      ],
      id: DID,
      verificationMethod: [
        {
          id: keyId,
          type: 'JsonWebKey2020',
          controller: DID,
          publicKeyJwk: fixtureJwk,
        },
      ],
      authentication: [keyId],
    });
  });

  test('accepts the valid public document through its public validator', () => {
    const document = buildDidDocument(fixtureJwk);
    expect(validateDidDocument(document)).toEqual(document);
  });

  test.each([
    ['a mismatched DID', { id: 'did:web:example.com' }],
    [
      'private key material',
      {
        verificationMethod: [
          {
            ...buildDidDocument(fixtureJwk).verificationMethod[0],
            publicKeyJwk: { ...fixtureJwk, d: 'private' },
          },
        ],
      },
    ],
    ['a key outside authentication', { authentication: [] }],
  ])('rejects %s', (_name, mutation) => {
    const document = buildDidDocument(fixtureJwk);
    expect(() => validateDidDocument({ ...document, ...mutation })).toThrow(
      'invalid_did_document',
    );
  });
});
