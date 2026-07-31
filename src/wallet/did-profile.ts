import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';
import { PUBLIC_PROFILE } from '../config/public-profile';

export const DID = PUBLIC_PROFILE.holderDid;
export const DID_DOCUMENT_URL = PUBLIC_PROFILE.holderDidDocumentUrl;

const contexts = [
  'https://www.w3.org/ns/did/v1',
  'https://w3id.org/security/suites/jws-2020/v1',
] as const;

export type PublicP256Jwk = {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  alg: 'ES256';
  use: 'sig';
};

export type DidDocument = {
  '@context': [typeof contexts[0], typeof contexts[1]];
  id: typeof DID;
  verificationMethod: [
    {
      id: string;
      type: 'JsonWebKey2020';
      controller: typeof DID;
      publicKeyJwk: PublicP256Jwk;
    },
  ];
  authentication: [string];
};

export class InvalidDidDocumentError extends Error {
  readonly code = 'invalid_did_document';

  constructor() {
    super('invalid_did_document');
  }
}

function invalid(): never {
  throw new InvalidDidDocumentError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(record).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function decodeCoordinate(value: unknown): Uint8Array {
  if (typeof value !== 'string' || value.includes('=')) {
    return invalid();
  }
  try {
    const decoded = base64urlnopad.decode(value);
    return decoded.length === 32 ? decoded : invalid();
  } catch {
    return invalid();
  }
}

export function publicJwkFromUncompressed(publicKey: Uint8Array): PublicP256Jwk {
  if (
    publicKey.length !== 65 ||
    publicKey[0] !== 4 ||
    !p256.utils.isValidPublicKey(publicKey, false)
  ) {
    return invalid();
  }
  return {
    kty: 'EC',
    crv: 'P-256',
    x: base64urlnopad.encode(publicKey.slice(1, 33)),
    y: base64urlnopad.encode(publicKey.slice(33, 65)),
    alg: 'ES256',
    use: 'sig',
  };
}

export function publicKeyFromJwk(jwk: PublicP256Jwk): Uint8Array {
  const x = decodeCoordinate(jwk.x);
  const y = decodeCoordinate(jwk.y);
  const publicKey = Uint8Array.from([4, ...x, ...y]);
  if (!p256.utils.isValidPublicKey(publicKey, false)) {
    return invalid();
  }
  return publicKey;
}

export function jwkThumbprint(jwk: PublicP256Jwk): string {
  const canonical = JSON.stringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
  return base64urlnopad.encode(sha256(new TextEncoder().encode(canonical)));
}

export function buildDidDocument(jwk: PublicP256Jwk): DidDocument {
  publicKeyFromJwk(jwk);
  const keyId = `${DID}#${jwkThumbprint(jwk)}`;
  return {
    '@context': [...contexts],
    id: DID,
    verificationMethod: [
      {
        id: keyId,
        type: 'JsonWebKey2020',
        controller: DID,
        publicKeyJwk: { ...jwk },
      },
    ],
    authentication: [keyId],
  };
}

function validateJwk(value: unknown): PublicP256Jwk {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['alg', 'crv', 'kty', 'use', 'x', 'y']) ||
    value.kty !== 'EC' ||
    value.crv !== 'P-256' ||
    value.alg !== 'ES256' ||
    value.use !== 'sig'
  ) {
    return invalid();
  }
  const jwk = value as PublicP256Jwk;
  publicKeyFromJwk(jwk);
  return jwk;
}

export function validateDidDocument(value: unknown): DidDocument {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['@context', 'authentication', 'id', 'verificationMethod']) ||
    value.id !== DID ||
    !Array.isArray(value['@context']) ||
    value['@context'].length !== 2 ||
    value['@context'][0] !== contexts[0] ||
    value['@context'][1] !== contexts[1] ||
    !Array.isArray(value.verificationMethod) ||
    value.verificationMethod.length !== 1 ||
    !Array.isArray(value.authentication) ||
    value.authentication.length !== 1
  ) {
    return invalid();
  }

  const method = value.verificationMethod[0];
  if (
    !isRecord(method) ||
    !hasExactKeys(method, ['controller', 'id', 'publicKeyJwk', 'type']) ||
    method.controller !== DID ||
    method.type !== 'JsonWebKey2020' ||
    typeof method.id !== 'string'
  ) {
    return invalid();
  }

  const jwk = validateJwk(method.publicKeyJwk);
  const expectedKeyId = `${DID}#${jwkThumbprint(jwk)}`;
  if (method.id !== expectedKeyId || value.authentication[0] !== expectedKeyId) {
    return invalid();
  }
  return value as DidDocument;
}
