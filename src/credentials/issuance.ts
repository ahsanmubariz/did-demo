import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import {
  publicKeyFromJwk,
  type DidDocument,
} from '../wallet/did-profile';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeJson(value: unknown): string {
  return base64urlnopad.encode(encoder.encode(JSON.stringify(value)));
}

function decodeJson(value: string): Record<string, unknown> {
  if (!value || value.includes('=') || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('invalid_credential_proof');
  }
  const decoded = JSON.parse(decoder.decode(base64urlnopad.decode(value))) as unknown;
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('invalid_credential_proof');
  }
  return decoded as Record<string, unknown>;
}

export function createCredentialProof(input: {
  secretKey: Uint8Array;
  keyId: string;
  audience: string;
  nonce: string;
  now: number;
}): string {
  if (
    !p256.utils.isValidSecretKey(input.secretKey) ||
    !input.keyId ||
    !input.audience ||
    !input.nonce ||
    !Number.isInteger(input.now)
  ) {
    throw new Error('invalid_credential_proof');
  }
  const header = encodeJson({
    alg: 'ES256',
    typ: 'openid4vci-proof+jwt',
    kid: input.keyId,
  });
  const payload = encodeJson({
    aud: input.audience,
    iat: input.now,
    nonce: input.nonce,
  });
  const signingInput = `${header}.${payload}`;
  const signature = p256.sign(encoder.encode(signingInput), input.secretKey, {
    format: 'compact',
  });
  return `${signingInput}.${base64urlnopad.encode(signature)}`;
}

export function verifyCredentialProof(input: {
  jwt: string;
  holderDocument: DidDocument;
  audience: string;
  nonce: string;
  now: number;
}): void {
  const segments = input.jwt.split('.');
  if (segments.length !== 3) throw new Error('invalid_credential_proof');
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('invalid_credential_proof');
  }
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  const method = input.holderDocument.verificationMethod[0];
  if (
    header.alg !== 'ES256' ||
    header.typ !== 'openid4vci-proof+jwt' ||
    header.kid !== method.id ||
    payload.aud !== input.audience ||
    payload.nonce !== input.nonce ||
    !Number.isInteger(payload.iat) ||
    Math.abs((payload.iat as number) - input.now) > 30
  ) {
    throw new Error('invalid_credential_proof');
  }
  let signature: Uint8Array;
  try {
    signature = base64urlnopad.decode(encodedSignature);
  } catch {
    throw new Error('invalid_credential_proof');
  }
  if (
    signature.length !== 64 ||
    !p256.verify(
      signature,
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
      publicKeyFromJwk(method.publicKeyJwk),
      { format: 'compact', lowS: false },
    )
  ) {
    throw new Error('invalid_credential_proof');
  }
}
