import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import {
  DID,
  publicKeyFromJwk,
  validateDidDocument,
  type DidDocument,
} from './did-profile';

export const PROOF_AUDIENCE = 'urn:did-demo:wallet-verifier' as const;

export type Challenge = {
  expectedDid: typeof DID;
  audience: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  consumed: boolean;
};

export type VerifiedProof = {
  did: typeof DID;
  keyId: string;
  issuedAt: number;
  expiresAt: number;
};

export type ProofErrorCode =
  | 'malformed_proof'
  | 'unsupported_algorithm'
  | 'unauthorized_key'
  | 'invalid_signature_encoding'
  | 'invalid_signature'
  | 'invalid_payload'
  | 'audience_mismatch'
  | 'challenge_mismatch'
  | 'expired_proof'
  | 'replayed_challenge';

export class ProofError extends Error {
  constructor(readonly code: ProofErrorCode) {
    super(code);
  }
}

function fail(code: ProofErrorCode): never {
  throw new ProofError(code);
}

function encodeJson(value: unknown): string {
  return base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeSegment(segment: string, code: ProofErrorCode): Uint8Array {
  if (!segment || segment.includes('=') || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    return fail(code);
  }
  try {
    return base64urlnopad.decode(segment);
  } catch {
    return fail(code);
  }
}

function parseObject(segment: string, code: ProofErrorCode): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeSegment(segment, code)));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return fail(code);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ProofError) {
      throw error;
    }
    return fail(code);
  }
}

function hasExactKeys(record: Record<string, unknown>, keys: string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(record).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function createChallenge(randomBytes: Uint8Array, now: number): Challenge {
  if (randomBytes.length !== 16 || !Number.isInteger(now)) {
    return fail('challenge_mismatch');
  }
  return {
    expectedDid: DID,
    audience: PROOF_AUDIENCE,
    nonce: base64urlnopad.encode(randomBytes),
    issuedAt: now,
    expiresAt: now + 120,
    consumed: false,
  };
}

export function signProof(
  secretKey: Uint8Array,
  keyId: string,
  challenge: Challenge,
  extraEntropy: Uint8Array,
): string {
  if (
    !p256.utils.isValidSecretKey(secretKey) ||
    extraEntropy.length !== 32 ||
    !keyId.startsWith(`${DID}#`)
  ) {
    return fail('challenge_mismatch');
  }
  const header = {
    alg: 'ES256',
    kid: keyId,
    typ: 'did-auth+jwt',
  };
  const payload = {
    iss: DID,
    aud: challenge.audience,
    iat: challenge.issuedAt,
    exp: challenge.expiresAt,
    nonce: challenge.nonce,
  };
  const encodedHeader = encodeJson(header);
  const encodedPayload = encodeJson(payload);
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = p256.sign(signingInput, secretKey, {
    format: 'compact',
    extraEntropy,
  });
  return `${encodedHeader}.${encodedPayload}.${base64urlnopad.encode(signature)}`;
}

export function verifyProof(
  compactProof: string,
  inputDocument: DidDocument,
  challenge: Challenge,
  now: number,
): VerifiedProof {
  const segments = compactProof.split('.');
  if (segments.length !== 3) {
    return fail('malformed_proof');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return fail('malformed_proof');
  }

  const header = parseObject(encodedHeader, 'malformed_proof');
  if (
    !hasExactKeys(header, ['alg', 'kid', 'typ']) ||
    header.alg !== 'ES256' ||
    header.typ !== 'did-auth+jwt'
  ) {
    return fail('unsupported_algorithm');
  }
  if (typeof header.kid !== 'string' || !header.kid.startsWith(`${challenge.expectedDid}#`)) {
    return fail('unauthorized_key');
  }

  const document = validateDidDocument(inputDocument);
  const method = document.verificationMethod.find((candidate) => candidate.id === header.kid);
  if (!method || !document.authentication.includes(method.id)) {
    return fail('unauthorized_key');
  }

  const signature = decodeSegment(encodedSignature, 'invalid_signature_encoding');
  if (signature.length !== 64) {
    return fail('invalid_signature_encoding');
  }
  const signingInput = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const publicKey = publicKeyFromJwk(method.publicKeyJwk);
  if (
    !p256.verify(signature, signingInput, publicKey, {
      format: 'compact',
      lowS: false,
    })
  ) {
    return fail('invalid_signature');
  }

  const payload = parseObject(encodedPayload, 'invalid_payload');
  if (
    !hasExactKeys(payload, ['aud', 'exp', 'iat', 'iss', 'nonce']) ||
    payload.iss !== challenge.expectedDid ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    typeof payload.nonce !== 'string'
  ) {
    return fail('invalid_payload');
  }
  if (payload.aud !== challenge.audience) {
    return fail('audience_mismatch');
  }
  if (
    payload.nonce !== challenge.nonce ||
    payload.iat !== challenge.issuedAt ||
    payload.exp !== challenge.expiresAt ||
    payload.exp !== payload.iat + 120
  ) {
    return fail('challenge_mismatch');
  }
  if (payload.iat > now + 30 || now >= payload.exp + 30) {
    return fail('expired_proof');
  }
  if (challenge.consumed) {
    return fail('replayed_challenge');
  }
  challenge.consumed = true;
  return {
    did: DID,
    keyId: method.id,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
}
