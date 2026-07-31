import { createPublicProfile } from './public-profile';

describe('createPublicProfile', () => {
  it('derives every public DID identifier from one HTTPS origin', () => {
    expect(createPublicProfile('https://wallet.example.test')).toEqual({
      origin: 'https://wallet.example.test',
      host: 'wallet.example.test',
      holderDid: 'did:web:wallet.example.test',
      holderDidDocumentUrl:
        'https://wallet.example.test/.well-known/did.json',
      issuerDid: 'did:web:wallet.example.test:issuer',
      rpDid: 'did:web:wallet.example.test:rp',
      rpClientId:
        'decentralized_identifier:did:web:wallet.example.test:rp',
      employeeVct:
        'https://wallet.example.test/credentials/employee/v1',
      employeeStatusListUri:
        'https://wallet.example.test/status/employee',
    });
  });

  it.each([
    '',
    'http://wallet.example.test',
    'https://wallet.example.test/path',
    'https://wallet.example.test?query=yes',
    'https://user:password@wallet.example.test',
  ])('rejects an invalid public origin: %s', (origin) => {
    expect(() => createPublicProfile(origin)).toThrow('invalid_public_origin');
  });
});
