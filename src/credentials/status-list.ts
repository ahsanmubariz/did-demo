import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import { deflateSync, inflateSync } from 'fflate';
import { ISSUER_DID } from './sd-jwt';
import { publicKeyFromJwk, type PublicP256Jwk } from '../wallet/did-profile';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeJson(value: unknown): string {
  return base64urlnopad.encode(encoder.encode(JSON.stringify(value)));
}

function decodeRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(decoder.decode(base64urlnopad.decode(value))) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error();
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error('invalid_status_list');
  }
}

function pack(statuses: boolean[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(statuses.length / 8));
  statuses.forEach((revoked, index) => {
    if (revoked) bytes[Math.floor(index / 8)]! |= 1 << (index % 8);
  });
  return bytes;
}

export function createStatusListToken(input: {
  issuerSecret: Uint8Array;
  issuerKeyId: string;
  uri: string;
  statuses: boolean[];
  now: number;
}): string {
  const header = encodeJson({
    alg: 'ES256',
    typ: 'statuslist+jwt',
    kid: input.issuerKeyId,
  });
  const payload = encodeJson({
    iss: ISSUER_DID,
    sub: input.uri,
    iat: input.now,
    exp: input.now + 5 * 60,
    status_list: {
      bits: 1,
      lst: base64urlnopad.encode(deflateSync(pack(input.statuses))),
      count: input.statuses.length,
    },
  });
  const signingInput = `${header}.${payload}`;
  const signature = p256.sign(
    encoder.encode(signingInput),
    input.issuerSecret,
    { format: 'compact' },
  );
  return `${signingInput}.${base64urlnopad.encode(signature)}`;
}

export function verifyStatusListToken(input: {
  token: string;
  issuerJwk: PublicP256Jwk;
  expectedUri: string;
  now: number;
}): boolean[] {
  const segments = input.token.split('.');
  if (segments.length !== 3) throw new Error('invalid_status_list');
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('invalid_status_list');
  }
  const header = decodeRecord(encodedHeader);
  const payload = decodeRecord(encodedPayload);
  const list =
    typeof payload.status_list === 'object' &&
    payload.status_list !== null &&
    !Array.isArray(payload.status_list)
      ? (payload.status_list as Record<string, unknown>)
      : undefined;
  let signature: Uint8Array;
  try {
    signature = base64urlnopad.decode(encodedSignature);
  } catch {
    throw new Error('invalid_status_list');
  }
  if (
    signature.length !== 64 ||
    !p256.verify(
      signature,
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
      publicKeyFromJwk(input.issuerJwk),
      { format: 'compact', lowS: false },
    ) ||
    header.alg !== 'ES256' ||
    header.typ !== 'statuslist+jwt' ||
    payload.iss !== ISSUER_DID ||
    payload.sub !== input.expectedUri ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    input.now >= (payload.exp as number) ||
    list?.bits !== 1 ||
    typeof list.lst !== 'string' ||
    !Number.isInteger(list.count) ||
    (list.count as number) < 0
  ) {
    throw new Error('invalid_status_list');
  }
  try {
    const bytes = inflateSync(base64urlnopad.decode(list.lst));
    return Array.from({ length: list.count as number }, (_, index) =>
      Boolean(bytes[Math.floor(index / 8)]! & (1 << (index % 8))),
    );
  } catch {
    throw new Error('invalid_status_list');
  }
}
