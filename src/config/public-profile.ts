export type PublicProfile = {
  origin: string;
  host: string;
  holderDid: string;
  holderDidDocumentUrl: string;
  issuerDid: string;
  rpDid: string;
  rpClientId: string;
  employeeVct: string;
  employeeStatusListUri: string;
};

function invalidPublicOrigin(): never {
  throw new Error('invalid_public_origin');
}

export function createPublicProfile(value: string): PublicProfile {
  const configured = value.trim();
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return invalidPublicOrigin();
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    return invalidPublicOrigin();
  }

  const origin = url.origin;
  const didHost = url.host.replace(':', '%3A');
  const holderDid = `did:web:${didHost}`;
  const issuerDid = `${holderDid}:issuer`;
  const rpDid = `${holderDid}:rp`;

  return {
    origin,
    host: url.host,
    holderDid,
    holderDidDocumentUrl: `${origin}/.well-known/did.json`,
    issuerDid,
    rpDid,
    rpClientId: `decentralized_identifier:${rpDid}`,
    employeeVct: `${origin}/credentials/employee/v1`,
    employeeStatusListUri: `${origin}/status/employee`,
  };
}

const configuredOrigin =
  process.env.EXPO_PUBLIC_COMPANION_ORIGIN ?? process.env.PUBLIC_ORIGIN;

if (!configuredOrigin) {
  throw new Error(
    'EXPO_PUBLIC_COMPANION_ORIGIN or PUBLIC_ORIGIN must be configured',
  );
}

export const PUBLIC_PROFILE = createPublicProfile(configuredOrigin);
