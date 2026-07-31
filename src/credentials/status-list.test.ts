import { p256 } from '@noble/curves/nist.js';
import {
  createStatusListToken,
  verifyStatusListToken,
} from './status-list';
import { ISSUER_DID } from './sd-jwt';
import { publicJwkFromUncompressed } from '../wallet/did-profile';

describe('Token Status List seam', () => {
  test('round-trips active and revoked status bits in a signed compressed list', () => {
    const secret = Uint8Array.from([...new Uint8Array(31), 5]);
    const uri =
      'https://wallet.example.test/status/employee';
    const token = createStatusListToken({
      issuerSecret: secret,
      issuerKeyId: `${ISSUER_DID}#status`,
      uri,
      statuses: [true, false, true],
      now: 1785373200,
    });

    expect(
      verifyStatusListToken({
        token,
        issuerJwk: publicJwkFromUncompressed(p256.getPublicKey(secret, false)),
        expectedUri: uri,
        now: 1785373201,
      }),
    ).toEqual([true, false, true]);
  });
});
