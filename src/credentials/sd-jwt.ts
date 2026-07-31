import { p256 } from '@noble/curves/nist.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64, base64urlnopad } from '@scure/base';
import { PUBLIC_PROFILE } from '../config/public-profile';
import {
  DID,
  publicKeyFromJwk,
  type PublicP256Jwk,
} from '../wallet/did-profile';

export const ISSUER_DID = PUBLIC_PROFILE.issuerDid;
export const RP_DID = PUBLIC_PROFILE.rpDid;
export const RP_CLIENT_ID = PUBLIC_PROFILE.rpClientId;
export const EMPLOYEE_VCT = PUBLIC_PROFILE.employeeVct;

export const employeeClaimNames = [
  'name',
  'email',
  'employee_id',
  'department',
  'employer',
  'employment_status',
] as const;

export const rpDisclosedClaimNames = [
  'name',
  'employer',
  'employment_status',
] as const;

export type EmployeeClaimName = (typeof employeeClaimNames)[number];
export type EmployeeClaims = Record<EmployeeClaimName, string>;
export type DisclosureSalts = Record<EmployeeClaimName, string>;

export const employeeTypeMetadata = {
  vct: EMPLOYEE_VCT,
  name: 'PERURI Employee Credential',
  description: 'Synthetic employment credential for the Identity Wallet demo.',
  display: [
    {
      locale: 'en-US',
      name: 'Employee Credential',
      description: 'Proof of active employment for partner access.',
    },
  ],
  claims: employeeClaimNames.map((name) => ({
    path: [name],
    display: [{ locale: 'en-US', label: name.replaceAll('_', ' ') }],
    sd: 'allowed',
  })),
} as const;

const employeeTypeMetadataIntegrity = `sha256-${base64.encode(
  sha256(new TextEncoder().encode(JSON.stringify(employeeTypeMetadata))),
)}`;

export type IssuedEmployeeCredential = {
  compact: string;
  disclosures: string[];
};

export type CredentialStatusReference = {
  idx: number;
  uri: string;
};

export type VerifiedEmployeePresentation = {
  issuer: typeof ISSUER_DID;
  holder: typeof DID;
  disclosed: Partial<EmployeeClaims>;
  withheld: EmployeeClaimName[];
  status: CredentialStatusReference;
  issuedAt: number;
  expiresAt: number;
};

export type CredentialErrorCode =
  | 'malformed_credential'
  | 'unsupported_credential'
  | 'untrusted_issuer'
  | 'invalid_issuer_signature'
  | 'invalid_disclosure'
  | 'invalid_holder_binding'
  | 'audience_mismatch'
  | 'nonce_mismatch'
  | 'credential_expired'
  | 'metadata_integrity_failed';

export class CredentialError extends Error {
  constructor(readonly code: CredentialErrorCode) {
    super(code);
  }
}

function fail(code: CredentialErrorCode): never {
  throw new CredentialError(code);
}

function encodeJson(value: unknown): string {
  return base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string, code: CredentialErrorCode): unknown {
  if (!value || value.includes('=') || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return fail(code);
  }
  try {
    return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(value))) as unknown;
  } catch {
    return fail(code);
  }
}

function record(value: unknown, code: CredentialErrorCode): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fail(code);
  }
  return value as Record<string, unknown>;
}

function signJws(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  secret: Uint8Array,
): string {
  if (!p256.utils.isValidSecretKey(secret)) return fail('invalid_holder_binding');
  const encodedHeader = encodeJson(header);
  const encodedPayload = encodeJson(payload);
  const input = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`);
  const signature = p256.sign(input, secret, { format: 'compact' });
  return `${encodedHeader}.${encodedPayload}.${base64urlnopad.encode(signature)}`;
}

function verifyJws(
  compact: string,
  publicJwk: PublicP256Jwk,
  signatureError: CredentialErrorCode,
): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
} {
  const segments = compact.split('.');
  if (segments.length !== 3) return fail('malformed_credential');
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return fail('malformed_credential');
  }
  let signature: Uint8Array;
  try {
    signature = base64urlnopad.decode(encodedSignature);
  } catch {
    return fail(signatureError);
  }
  if (
    signature.length !== 64 ||
    !p256.verify(
      signature,
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
      publicKeyFromJwk(publicJwk),
      { format: 'compact', lowS: false },
    )
  ) {
    return fail(signatureError);
  }
  return {
    header: record(decodeJson(encodedHeader, 'malformed_credential'), 'malformed_credential'),
    payload: record(
      decodeJson(encodedPayload, 'malformed_credential'),
      'malformed_credential',
    ),
  };
}

function disclosureFor(
  salt: string,
  name: EmployeeClaimName,
  value: string,
): string {
  return encodeJson([salt, name, value]);
}

function disclosureDigest(disclosure: string): string {
  return base64urlnopad.encode(sha256(new TextEncoder().encode(disclosure)));
}

export function createEmployeeCredential(input: {
  issuerSecret: Uint8Array;
  issuerKeyId: string;
  holderDid: typeof DID;
  holderJwk: PublicP256Jwk;
  claims: EmployeeClaims;
  salts: DisclosureSalts;
  now: number;
  status: CredentialStatusReference;
}): IssuedEmployeeCredential {
  if (
    !input.issuerKeyId.startsWith(`${ISSUER_DID}#`) ||
    input.holderDid !== DID ||
    !Number.isInteger(input.now) ||
    !Number.isInteger(input.status.idx) ||
    input.status.idx < 0 ||
    !input.status.uri.startsWith('https://')
  ) {
    return fail('unsupported_credential');
  }
  publicKeyFromJwk(input.holderJwk);
  const disclosures = employeeClaimNames.map((name) =>
    disclosureFor(input.salts[name], name, input.claims[name]),
  );
  const payload = {
    iss: ISSUER_DID,
    sub: DID,
    iat: input.now,
    exp: input.now + 7 * 24 * 60 * 60,
    vct: EMPLOYEE_VCT,
    'vct#integrity': employeeTypeMetadataIntegrity,
    cnf: { jwk: input.holderJwk },
    status: {
      status_list: {
        idx: input.status.idx,
        uri: input.status.uri,
      },
    },
    _sd_alg: 'sha-256',
    _sd: disclosures.map(disclosureDigest),
  };
  const issuerJws = signJws(
    {
      alg: 'ES256',
      typ: 'dc+sd-jwt',
      kid: input.issuerKeyId,
    },
    payload,
    input.issuerSecret,
  );
  return {
    compact: `${issuerJws}~${disclosures.join('~')}~`,
    disclosures,
  };
}

function parseDisclosure(disclosure: string): {
  name: EmployeeClaimName;
  value: string;
} {
  const decoded = decodeJson(disclosure, 'invalid_disclosure');
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 3 ||
    typeof decoded[0] !== 'string' ||
    typeof decoded[1] !== 'string' ||
    typeof decoded[2] !== 'string' ||
    !employeeClaimNames.includes(decoded[1] as EmployeeClaimName)
  ) {
    return fail('invalid_disclosure');
  }
  return {
    name: decoded[1] as EmployeeClaimName,
    value: decoded[2],
  };
}

export function createEmployeePresentation(input: {
  credential: IssuedEmployeeCredential;
  holderSecret: Uint8Array;
  audience: typeof RP_CLIENT_ID;
  nonce: string;
  now: number;
  disclose: EmployeeClaimName[];
}): string {
  if (
    input.audience !== RP_CLIENT_ID ||
    !input.nonce ||
    !Number.isInteger(input.now) ||
    input.disclose.some((name) => !employeeClaimNames.includes(name))
  ) {
    return fail('invalid_holder_binding');
  }
  const issuerJws = input.credential.compact.split('~')[0];
  if (!issuerJws) return fail('malformed_credential');
  const wanted = new Set(input.disclose);
  const selected = input.credential.disclosures.filter((disclosure) =>
    wanted.has(parseDisclosure(disclosure).name),
  );
  if (selected.length !== wanted.size) return fail('invalid_disclosure');
  const presentedSdJwt = `${issuerJws}~${selected.join('~')}~`;
  const kbJwt = signJws(
    { alg: 'ES256', typ: 'kb+jwt' },
    {
      aud: input.audience,
      nonce: input.nonce,
      iat: input.now,
      sd_hash: base64urlnopad.encode(
        sha256(new TextEncoder().encode(presentedSdJwt)),
      ),
    },
    input.holderSecret,
  );
  return `${presentedSdJwt}${kbJwt}`;
}

export function matchEmployeeDcql(value: unknown): EmployeeClaimName[] {
  const query = record(value, 'unsupported_credential');
  if (Object.keys(query).length !== 1 || !Array.isArray(query.credentials)) {
    return fail('unsupported_credential');
  }
  if (query.credentials.length !== 1) return fail('unsupported_credential');
  const credential = record(query.credentials[0], 'unsupported_credential');
  if (
    Object.keys(credential).sort().join(',') !== 'claims,format,id,meta' ||
    credential.id !== 'employee' ||
    credential.format !== 'dc+sd-jwt' ||
    !Array.isArray(credential.claims)
  ) {
    return fail('unsupported_credential');
  }
  const meta = record(credential.meta, 'unsupported_credential');
  if (
    Object.keys(meta).length !== 1 ||
    !Array.isArray(meta.vct_values) ||
    meta.vct_values.length !== 1 ||
    meta.vct_values[0] !== EMPLOYEE_VCT
  ) {
    return fail('unsupported_credential');
  }
  const names = credential.claims.map((candidate) => {
    const claim = record(candidate, 'unsupported_credential');
    if (
      Object.keys(claim).length !== 1 ||
      !Array.isArray(claim.path) ||
      claim.path.length !== 1 ||
      typeof claim.path[0] !== 'string' ||
      !employeeClaimNames.includes(claim.path[0] as EmployeeClaimName)
    ) {
      return fail('unsupported_credential');
    }
    return claim.path[0] as EmployeeClaimName;
  });
  if (
    names.length !== rpDisclosedClaimNames.length ||
    names.some((name, index) => name !== rpDisclosedClaimNames[index])
  ) {
    return fail('unsupported_credential');
  }
  return names;
}

function parseStatus(value: unknown): CredentialStatusReference {
  const status = record(value, 'unsupported_credential');
  const statusList = record(status.status_list, 'unsupported_credential');
  if (
    !Number.isInteger(statusList.idx) ||
    (statusList.idx as number) < 0 ||
    typeof statusList.uri !== 'string' ||
    !statusList.uri.startsWith('https://')
  ) {
    return fail('unsupported_credential');
  }
  return { idx: statusList.idx as number, uri: statusList.uri };
}

export function verifyEmployeePresentation(input: {
  presentation: string;
  issuerJwk: PublicP256Jwk;
  expectedAudience: typeof RP_CLIENT_ID;
  expectedNonce: string;
  now: number;
}): VerifiedEmployeePresentation {
  const parts = input.presentation.split('~');
  if (parts.length < 2) return fail('malformed_credential');
  const issuerJws = parts[0];
  const kbJwt = parts.at(-1);
  if (!issuerJws || !kbJwt) return fail('malformed_credential');
  const disclosures = parts.slice(1, -1);

  const issuer = verifyJws(issuerJws, input.issuerJwk, 'invalid_issuer_signature');
  if (
    issuer.header.alg !== 'ES256' ||
    issuer.header.typ !== 'dc+sd-jwt' ||
    typeof issuer.header.kid !== 'string' ||
    !issuer.header.kid.startsWith(`${ISSUER_DID}#`)
  ) {
    return fail('untrusted_issuer');
  }
  const payload = issuer.payload;
  if (
    payload.iss !== ISSUER_DID ||
    payload.sub !== DID ||
    payload.vct !== EMPLOYEE_VCT ||
    payload._sd_alg !== 'sha-256' ||
    !Array.isArray(payload._sd) ||
    !payload._sd.every((digest) => typeof digest === 'string') ||
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp)
  ) {
    return fail('unsupported_credential');
  }
  if (payload['vct#integrity'] !== employeeTypeMetadataIntegrity) {
    return fail('metadata_integrity_failed');
  }
  if ((payload.iat as number) > input.now + 30 || input.now >= (payload.exp as number)) {
    return fail('credential_expired');
  }

  const digests = new Set(payload._sd as string[]);
  const disclosed: Partial<EmployeeClaims> = {};
  for (const disclosure of disclosures) {
    if (!digests.has(disclosureDigest(disclosure))) {
      return fail('invalid_disclosure');
    }
    const parsed = parseDisclosure(disclosure);
    if (disclosed[parsed.name] !== undefined) return fail('invalid_disclosure');
    disclosed[parsed.name] = parsed.value;
  }
  const disclosedNames = Object.keys(disclosed) as EmployeeClaimName[];
  if (
    disclosedNames.length !== rpDisclosedClaimNames.length ||
    rpDisclosedClaimNames.some((name) => disclosed[name] === undefined)
  ) {
    return fail('invalid_disclosure');
  }

  const cnf = record(payload.cnf, 'invalid_holder_binding');
  const holderJwk = cnf.jwk as PublicP256Jwk;
  publicKeyFromJwk(holderJwk);
  const keyBinding = verifyJws(kbJwt, holderJwk, 'invalid_holder_binding');
  if (keyBinding.header.alg !== 'ES256' || keyBinding.header.typ !== 'kb+jwt') {
    return fail('invalid_holder_binding');
  }
  if (keyBinding.payload.aud !== input.expectedAudience) {
    return fail('audience_mismatch');
  }
  if (keyBinding.payload.nonce !== input.expectedNonce) {
    return fail('nonce_mismatch');
  }
  const presentedSdJwt = `${parts.slice(0, -1).join('~')}~`;
  const expectedHash = base64urlnopad.encode(
    sha256(new TextEncoder().encode(presentedSdJwt)),
  );
  if (
    keyBinding.payload.sd_hash !== expectedHash ||
    !Number.isInteger(keyBinding.payload.iat) ||
    Math.abs((keyBinding.payload.iat as number) - input.now) > 30
  ) {
    return fail('invalid_holder_binding');
  }

  return {
    issuer: ISSUER_DID,
    holder: DID,
    disclosed,
    withheld: employeeClaimNames.filter((name) => disclosed[name] === undefined),
    status: parseStatus(payload.status),
    issuedAt: payload.iat as number,
    expiresAt: payload.exp as number,
  };
}
