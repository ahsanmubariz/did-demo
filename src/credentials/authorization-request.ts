import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import {
  EMPLOYEE_VCT,
  matchEmployeeDcql,
  RP_DID,
  RP_CLIENT_ID,
  type EmployeeClaimName,
} from './sd-jwt';
import { publicKeyFromJwk, type PublicP256Jwk } from '../wallet/did-profile';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function encodeJson(value: unknown): string {
  return base64urlnopad.encode(encoder.encode(JSON.stringify(value)));
}

function decodeRecord(encoded: string): Record<string, unknown> {
  try {
    const value = JSON.parse(decoder.decode(base64urlnopad.decode(encoded))) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error();
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error('invalid_authorization_request');
  }
}

export const employeeDcqlQuery = {
  credentials: [
    {
      id: 'employee',
      format: 'dc+sd-jwt',
      meta: {
        vct_values: [EMPLOYEE_VCT],
      },
      claims: [
        { path: ['name'] },
        { path: ['employer'] },
        { path: ['employment_status'] },
      ],
    },
  ],
} as const;

export type VerifiedAuthorizationRequest = {
  clientId: typeof RP_CLIENT_ID;
  responseUri: string;
  nonce: string;
  state: string;
  claims: EmployeeClaimName[];
};

export function createAuthorizationRequest(input: {
  rpSecret: Uint8Array;
  rpKeyId: string;
  responseUri: string;
  nonce: string;
  state: string;
  now: number;
}): string {
  const header = encodeJson({
    alg: 'ES256',
    typ: 'oauth-authz-req+jwt',
    kid: input.rpKeyId,
  });
  const payload = encodeJson({
    iss: RP_CLIENT_ID,
    aud: 'https://self-issued.me/v2',
    client_id: RP_CLIENT_ID,
    response_type: 'vp_token',
    response_mode: 'direct_post',
    response_uri: input.responseUri,
    nonce: input.nonce,
    state: input.state,
    dcql_query: employeeDcqlQuery,
    iat: input.now,
    exp: input.now + 5 * 60,
  });
  const signingInput = `${header}.${payload}`;
  const signature = p256.sign(encoder.encode(signingInput), input.rpSecret, {
    format: 'compact',
  });
  return `${signingInput}.${base64urlnopad.encode(signature)}`;
}

export function verifyAuthorizationRequest(input: {
  jwt: string;
  rpJwk: PublicP256Jwk;
  expectedAudience: 'https://self-issued.me/v2';
  now: number;
}): VerifiedAuthorizationRequest {
  const segments = input.jwt.split('.');
  if (segments.length !== 3) throw new Error('invalid_authorization_request');
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error('invalid_authorization_request');
  }
  const header = decodeRecord(encodedHeader);
  const payload = decodeRecord(encodedPayload);
  let signature: Uint8Array;
  try {
    signature = base64urlnopad.decode(encodedSignature);
  } catch {
    throw new Error('invalid_authorization_request');
  }
  if (
    signature.length !== 64 ||
    !p256.verify(
      signature,
      encoder.encode(`${encodedHeader}.${encodedPayload}`),
      publicKeyFromJwk(input.rpJwk),
      { format: 'compact', lowS: false },
    ) ||
    header.alg !== 'ES256' ||
    header.typ !== 'oauth-authz-req+jwt' ||
    typeof header.kid !== 'string' ||
    !header.kid.startsWith(`${RP_DID}#`) ||
    payload.iss !== RP_CLIENT_ID ||
    payload.client_id !== RP_CLIENT_ID ||
    payload.aud !== input.expectedAudience ||
    payload.response_type !== 'vp_token' ||
    payload.response_mode !== 'direct_post' ||
    typeof payload.response_uri !== 'string' ||
    typeof payload.nonce !== 'string' ||
    typeof payload.state !== 'string' ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    (payload.iat as number) > input.now + 30 ||
    input.now >= (payload.exp as number)
  ) {
    throw new Error('invalid_authorization_request');
  }
  return {
    clientId: RP_CLIENT_ID,
    responseUri: payload.response_uri,
    nonce: payload.nonce,
    state: payload.state,
    claims: matchEmployeeDcql(payload.dcql_query),
  };
}
