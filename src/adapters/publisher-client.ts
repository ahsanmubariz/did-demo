import {
  DID,
  validateDidDocument,
  type DidDocument,
} from '../wallet/did-profile';

export type PublisherHealth = {
  status: 'ok';
  document: 'present' | 'absent';
};

export class PublisherClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

type ErrorBody = { error?: unknown; message?: unknown };

async function toPublisherError(response: Response): Promise<PublisherClientError> {
  let body: ErrorBody = {};
  try {
    body = (await response.json()) as ErrorBody;
  } catch {
    // The stable fallback below deliberately ignores non-JSON upstream bodies.
  }
  const code = typeof body.error === 'string' ? body.error : 'publisher_unavailable';
  const message =
    typeof body.message === 'string' ? body.message : `Publisher returned HTTP ${response.status}`;
  return new PublisherClientError(code, message, response.status);
}

export class HttpPublisherClient {
  constructor(private readonly origin: string) {}

  async health(): Promise<PublisherHealth> {
    const response = await this.request('/healthz');
    if (!response.ok) throw await toPublisherError(response);
    return (await response.json()) as PublisherHealth;
  }

  async publish(document: DidDocument, pairingToken: string): Promise<void> {
    const response = await this.request('/api/did', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${pairingToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(document),
    });
    if (!response.ok) throw await toPublisherError(response);
  }

  async resolve(): Promise<DidDocument> {
    const response = await this.request('/.well-known/did.json', {
      headers: {
        Accept: 'application/did+ld+json, application/json',
      },
      redirect: 'manual',
    });
    if (!response.ok) throw await toPublisherError(response);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0];
    if (contentType !== 'application/did+ld+json' && contentType !== 'application/json') {
      throw new PublisherClientError(
        'resolution_content_type',
        'Publisher returned an unsupported DID media type',
      );
    }
    const text = await response.text();
    if (new TextEncoder().encode(text).length > 64 * 1024) {
      throw new PublisherClientError('resolution_too_large', 'DID document exceeds 64 KiB');
    }
    try {
      const document = validateDidDocument(JSON.parse(text) as unknown);
      if (document.id !== DID) {
        throw new Error('DID mismatch');
      }
      return document;
    } catch {
      throw new PublisherClientError(
        'invalid_did_document',
        'Resolved DID document failed profile validation',
      );
    }
  }

  async reset(pairingToken: string): Promise<void> {
    const response = await this.request('/api/operator/reset', {
      method: 'POST',
      headers: { Authorization: `Bearer ${pairingToken}` },
    });
    if (!response.ok) throw await toPublisherError(response);
  }

  async revokeActiveCredential(pairingToken: string): Promise<void> {
    const response = await this.request(
      '/api/operator/credentials/active/revoke',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${pairingToken}` },
      },
    );
    if (!response.ok) throw await toPublisherError(response);
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      const headers = new Headers(init.headers);
      headers.set('ngrok-skip-browser-warning', 'did-demo');
      return await fetch(`${this.origin}${path}`, {
        ...init,
        headers,
      });
    } catch (error) {
      throw new PublisherClientError(
        'publisher_unavailable',
        error instanceof Error ? error.message : 'Publisher is unavailable',
      );
    }
  }
}
