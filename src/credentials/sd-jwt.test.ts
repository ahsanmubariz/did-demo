import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import { publicJwkFromUncompressed } from '../wallet/did-profile';
import {
  EMPLOYEE_VCT,
  createEmployeeCredential,
  createEmployeePresentation,
  employeeTypeMetadata,
  matchEmployeeDcql,
  verifyEmployeePresentation,
} from './sd-jwt';

const issuerSecret = Uint8Array.from([...new Uint8Array(31), 1]);
const holderSecret = Uint8Array.from([...new Uint8Array(31), 2]);
const issuerJwk = publicJwkFromUncompressed(p256.getPublicKey(issuerSecret, false));
const holderJwk = publicJwkFromUncompressed(p256.getPublicKey(holderSecret, false));

const claims = {
  name: 'Alya Pratama',
  email: 'alya.pratama@employee.test',
  employee_id: 'EMP-DEMO-001',
  department: 'Digital Trust Lab',
  employer: 'DUMMY-CORP',
  employment_status: 'active',
} as const;

const salts = {
  name: 'salt-name',
  email: 'salt-email',
  employee_id: 'salt-id',
  department: 'salt-dept',
  employer: 'salt-employer',
  employment_status: 'salt-status',
};

function decodePayload(compact: string): Record<string, unknown> {
  const issuerJws = compact.split('~')[0];
  if (!issuerJws) throw new Error('missing issuer JWS');
  const payload = issuerJws.split('.')[1];
  if (!payload) throw new Error('missing payload');
  return JSON.parse(new TextDecoder().decode(base64urlnopad.decode(payload))) as Record<
    string,
    unknown
  >;
}

describe('SD-JWT Employee Credential seam', () => {
  test('issues the fixed selective-disclosure profile with independently known digests', () => {
    const credential = createEmployeeCredential({
      issuerSecret,
      issuerKeyId:
        'did:web:wallet.example.test:issuer#issuer-key',
      holderDid: 'did:web:wallet.example.test',
      holderJwk,
      claims,
      salts,
      now: 1_800_000_000,
      status: {
        idx: 7,
        uri: 'https://wallet.example.test/issuer/status/1',
      },
    });

    expect(decodePayload(credential.compact)).toMatchObject({
      iss: 'did:web:wallet.example.test:issuer',
      sub: 'did:web:wallet.example.test',
      iat: 1_800_000_000,
      exp: 1_800_604_800,
      vct: EMPLOYEE_VCT,
      _sd_alg: 'sha-256',
      _sd: [
        'PUZq6jXSD6lPmdvmNTRe7N8ZHXwMtlNxTK_V1oT7SWQ',
        'cdhIQS-L0C-HJB21HFpouEmMwxwuV3grNgtlozzTEvA',
        'y3BWHQ_6Vx0A5v3u3pesBdFoVQvJDS1B2sky5C0hp68',
        'W4XWI48WyiKWdoAy8hlbkJ3XiYk8f7S5S4-ZXOZ1NiE',
        'BH96OzAnC5gLr-Utv4YuhUalHfsnZCcGiWqLGDBmQLY',
        'X6zeB_3uBlpT8f4HetUZyHHvwyVXgvBqMpayYedL6mw',
      ],
    });
    expect(employeeTypeMetadata.vct).toBe(EMPLOYEE_VCT);
    expect(credential.disclosures).toHaveLength(6);
  });

  test('presents only the DCQL-approved claims with holder binding', () => {
    const credential = createEmployeeCredential({
      issuerSecret,
      issuerKeyId:
        'did:web:wallet.example.test:issuer#issuer-key',
      holderDid: 'did:web:wallet.example.test',
      holderJwk,
      claims,
      salts,
      now: 1_800_000_000,
      status: {
        idx: 7,
        uri: 'https://wallet.example.test/issuer/status/1',
      },
    });
    const presentation = createEmployeePresentation({
      credential,
      holderSecret,
      audience:
        'decentralized_identifier:did:web:wallet.example.test:rp',
      nonce: 'fixed-presentation-nonce',
      now: 1_800_000_030,
      disclose: ['name', 'employer', 'employment_status'],
    });

    const verified = verifyEmployeePresentation({
      presentation,
      issuerJwk,
      expectedAudience:
        'decentralized_identifier:did:web:wallet.example.test:rp',
      expectedNonce: 'fixed-presentation-nonce',
      now: 1_800_000_030,
    });

    expect(verified.disclosed).toEqual({
      name: 'Alya Pratama',
      employer: 'DUMMY-CORP',
      employment_status: 'active',
    });
    expect(verified.withheld).toEqual(['email', 'employee_id', 'department']);
  });

  test('accepts only the partner access DCQL contract', () => {
    const query = {
      credentials: [
        {
          id: 'employee',
          format: 'dc+sd-jwt',
          meta: { vct_values: [EMPLOYEE_VCT] },
          claims: [
            { path: ['name'] },
            { path: ['employer'] },
            { path: ['employment_status'] },
          ],
        },
      ],
    };

    expect(matchEmployeeDcql(query)).toEqual([
      'name',
      'employer',
      'employment_status',
    ]);
    expect(() =>
      matchEmployeeDcql({
        ...query,
        credentials: [
          {
            ...query.credentials[0]!,
            claims: [...query.credentials[0]!.claims, { path: ['email'] }],
          },
        ],
      }),
    ).toThrow('unsupported_credential');
  });

  test('rejects a presentation that discloses more than the RP requested', () => {
    const credential = createEmployeeCredential({
      issuerSecret,
      issuerKeyId:
        'did:web:wallet.example.test:issuer#issuer-key',
      holderDid: 'did:web:wallet.example.test',
      holderJwk,
      claims,
      salts,
      now: 1_800_000_000,
      status: {
        idx: 7,
        uri: 'https://wallet.example.test/issuer/status/1',
      },
    });
    const presentation = createEmployeePresentation({
      credential,
      holderSecret,
      audience:
        'decentralized_identifier:did:web:wallet.example.test:rp',
      nonce: 'fixed-presentation-nonce',
      now: 1_800_000_030,
      disclose: ['name', 'employer', 'employment_status', 'email'],
    });

    expect(() =>
      verifyEmployeePresentation({
        presentation,
        issuerJwk,
        expectedAudience:
          'decentralized_identifier:did:web:wallet.example.test:rp',
        expectedNonce: 'fixed-presentation-nonce',
        now: 1_800_000_030,
      }),
    ).toThrow('invalid_disclosure');
  });
});
