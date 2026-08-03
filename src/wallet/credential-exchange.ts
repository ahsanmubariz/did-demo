import type { CredentialVault, StoredCredential } from './credential-vault';
import {
  verifyAuthorizationRequest,
  type VerifiedAuthorizationRequest,
} from '../credentials/authorization-request';
import type {
  EmployeeClaimName,
  IssuedEmployeeCredential,
} from '../credentials/sd-jwt';
import type { PublicP256Jwk } from './did-profile';
import { verifyStatusListToken } from '../credentials/status-list';
import { base64urlnopad } from '@scure/base';

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type CredentialOffer = {
  credential_issuer: string;
  credential_configuration_ids: string[];
  grants: {
    'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
      'pre-authorized_code': string;
      tx_code: { input_mode: string; length: number };
    };
  };
};

type IssuerMetadata = {
  credential_issuer: string;
  token_endpoint: string;
  credential_endpoint: string;
  nonce_endpoint: string;
  notification_endpoint: string;
};

export type PresentationRequest = VerifiedAuthorizationRequest & {
  requestUri: string;
};

async function requiredJson<T>(response: Response, code: string): Promise<T> {
  if (!response.ok) throw new Error(code);
  return response.json() as Promise<T>;
}

export class CredentialExchangeWallet {
  constructor(
    private readonly dependencies: {
      fetch: Fetch;
      vault: Pick<CredentialVault, 'save'>;
      identity: {
        createCredentialProof(input: {
          audience: string;
          nonce: string;
          now: number;
        }): string;
        createEmployeePresentation?(input: {
          credential: IssuedEmployeeCredential;
          audience: string;
          nonce: string;
          now: number;
          disclose: EmployeeClaimName[];
        }): string;
      };
      clock: { nowSeconds(): number };
      trustedOrigin?: string;
    },
  ) {}

  async acceptOffer(
    credentialOfferUri: string,
    transactionCode: string,
  ): Promise<StoredCredential> {
    if (!credentialOfferUri.startsWith('https://') || !/^\d{6}$/.test(transactionCode)) {
      throw new Error('invalid_credential_offer');
    }
    const offer = await requiredJson<CredentialOffer>(
      await this.dependencies.fetch(credentialOfferUri),
      'credential_offer_failed',
    );
    const grant =
      offer.grants?.[
        'urn:ietf:params:oauth:grant-type:pre-authorized_code'
      ];
    if (
      !offer.credential_issuer?.startsWith('https://') ||
      offer.credential_configuration_ids?.length !== 1 ||
      offer.credential_configuration_ids[0] !== 'EmployeeCredential' ||
      !grant?.['pre-authorized_code'] ||
      grant.tx_code?.input_mode !== 'numeric' ||
      grant.tx_code?.length !== 6
    ) {
      throw new Error('invalid_credential_offer');
    }
    const metadata = await requiredJson<IssuerMetadata>(
      await this.dependencies.fetch(
        `${offer.credential_issuer}/.well-known/openid-credential-issuer`,
      ),
      'issuer_metadata_failed',
    );
    if (
      metadata.credential_issuer !== offer.credential_issuer ||
      ![
        metadata.token_endpoint,
        metadata.credential_endpoint,
        metadata.nonce_endpoint,
        metadata.notification_endpoint,
      ].every((endpoint) => endpoint.startsWith(`${offer.credential_issuer}/`))
    ) {
      throw new Error('untrusted_credential_issuer');
    }
    const token = await requiredJson<{ access_token: string }>(
      await this.dependencies.fetch(metadata.token_endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:
            'urn:ietf:params:oauth:grant-type:pre-authorized_code',
          'pre-authorized_code': grant['pre-authorized_code'],
          tx_code: transactionCode,
        }).toString(),
      }),
      'credential_authorization_failed',
    );
    const nonce = await requiredJson<{ c_nonce: string }>(
      await this.dependencies.fetch(metadata.nonce_endpoint, { method: 'POST' }),
      'credential_nonce_failed',
    );
    const now = this.dependencies.clock.nowSeconds();
    const proof = this.dependencies.identity.createCredentialProof({
      audience: metadata.credential_issuer,
      nonce: nonce.c_nonce,
      now,
    });
    const issued = await requiredJson<{
      credentials: { credential: string }[];
      notification_id: string;
    }>(
      await this.dependencies.fetch(metadata.credential_endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          credential_configuration_id: 'EmployeeCredential',
          proof: { proof_type: 'jwt', jwt: proof },
        }),
      }),
      'credential_issuance_failed',
    );
    const compact = issued.credentials?.[0]?.credential;
    if (!compact || !issued.notification_id) {
      throw new Error('invalid_issued_credential');
    }
    const credential: StoredCredential = {
      id: issued.notification_id,
      compact,
      issuer: 'DUMMY-CORP Demo Issuer',
      type: 'Employee Credential',
      issuedAt: now,
      expiresAt: now + 7 * 24 * 60 * 60,
      status: 'active',
    };
    await this.dependencies.vault.save(credential);
    const notification = await this.dependencies.fetch(
      metadata.notification_endpoint,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          notification_id: issued.notification_id,
          event: 'credential_accepted',
        }),
      },
    );
    if (!notification.ok) throw new Error('credential_notification_failed');
    return credential;
  }

  async inspectPresentationRequest(
    requestUri: string,
  ): Promise<PresentationRequest> {
    const origin = this.dependencies.trustedOrigin ?? new URL(requestUri).origin;
    if (
      !requestUri.startsWith(`${origin}/rp/requests/`) ||
      !origin.startsWith('https://')
    ) {
      throw new Error('untrusted_presentation_request');
    }
    const requestResponse = await this.dependencies.fetch(requestUri);
    if (!requestResponse.ok) throw new Error('presentation_request_failed');
    const jwt = await requestResponse.text();
    const rpDocumentResponse = await this.dependencies.fetch(
      `${origin}/rp/did.json`,
    );
    const rpDocument = await requiredJson<{
      verificationMethod: { publicKeyJwk: PublicP256Jwk }[];
    }>(rpDocumentResponse, 'rp_did_resolution_failed');
    const rpJwk = rpDocument.verificationMethod?.[0]?.publicKeyJwk;
    if (!rpJwk) throw new Error('rp_did_resolution_failed');
    return {
      requestUri,
      ...verifyAuthorizationRequest({
        jwt,
        rpJwk,
        expectedAudience: 'https://self-issued.me/v2',
        now: this.dependencies.clock.nowSeconds(),
      }),
    };
  }

  async respondToPresentation(
    request: PresentationRequest,
    credential: StoredCredential,
    approve: boolean,
  ): Promise<{ redirectUri: string; outcome: 'shared' | 'denied' }> {
    const form = new URLSearchParams({ state: request.state });
    if (approve) {
      if (
        !this.dependencies.identity.createEmployeePresentation ||
        credential.status !== 'active'
      ) {
        throw new Error('active_credential_required');
      }
      const parts = credential.compact.split('~');
      const presentation =
        this.dependencies.identity.createEmployeePresentation({
        credential: {
          compact: credential.compact,
          disclosures: parts.slice(1, -1),
        },
        audience: request.clientId,
        nonce: request.nonce,
        now: this.dependencies.clock.nowSeconds(),
        disclose: request.claims,
      });
      form.set('vp_token', presentation);
    } else {
      form.set('error', 'access_denied');
    }
    const response = await requiredJson<{ redirect_uri: string }>(
      await this.dependencies.fetch(request.responseUri, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }),
      'presentation_submission_failed',
    );
    return {
      redirectUri: response.redirect_uri,
      outcome: approve ? 'shared' : 'denied',
    };
  }

  async refreshCredentialStatus(
    credential: StoredCredential,
  ): Promise<StoredCredential> {
    const origin = this.dependencies.trustedOrigin;
    if (!origin) throw new Error('trusted_issuer_required');
    try {
      const issuerJwt = credential.compact.split('~')[0];
      const encodedPayload = issuerJwt?.split('.')[1];
      if (!encodedPayload) throw new Error();
      const payload = JSON.parse(
        new TextDecoder().decode(base64urlnopad.decode(encodedPayload)),
      ) as {
        status?: { status_list?: { idx?: unknown; uri?: unknown } };
      };
      const index = payload.status?.status_list?.idx;
      const uri = payload.status?.status_list?.uri;
      if (
        !Number.isInteger(index) ||
        typeof uri !== 'string' ||
        uri !== `${origin}/status/employee`
      ) {
        throw new Error();
      }
      const [statusResponse, issuerResponse] = await Promise.all([
        this.dependencies.fetch(uri),
        this.dependencies.fetch(`${origin}/issuer/did.json`),
      ]);
      if (!statusResponse.ok) throw new Error();
      const token = await statusResponse.text();
      const issuerDocument = await requiredJson<{
        verificationMethod: { publicKeyJwk: PublicP256Jwk }[];
      }>(issuerResponse, 'issuer_did_resolution_failed');
      const issuerJwk = issuerDocument.verificationMethod?.[0]?.publicKeyJwk;
      if (!issuerJwk) throw new Error();
      const statuses = verifyStatusListToken({
        token,
        issuerJwk,
        expectedUri: uri,
        now: this.dependencies.clock.nowSeconds(),
      });
      if (statuses[index as number] !== true) return credential;
      const revoked: StoredCredential = { ...credential, status: 'revoked' };
      await this.dependencies.vault.save(revoked);
      return revoked;
    } catch {
      throw new Error('credential_status_unavailable');
    }
  }
}
