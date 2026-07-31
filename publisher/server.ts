import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { validateDidDocument, type DidDocument } from '../src/wallet/did-profile';
import { persistDocument, removeDocument } from './file-store';

export type PublisherOptions = {
  host: string;
  port: number;
  stateFile: string;
  pairingToken: string;
};

export type RunningPublisher = {
  origin: string;
  close(): Promise<void>;
};

const jsonHeaders = {
  'Cache-Control': 'no-store',
  'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff',
};

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  response.writeHead(status, { ...jsonHeaders, ...headers });
  response.end(JSON.stringify(body));
}

function hasPairingToken(header: string | undefined, expectedToken: string): boolean {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) return false;
  const received = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length <= 64 * 1024) chunks.push(bytes);
  }
  if (length > 64 * 1024) {
    throw new Error('payload_too_large');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid_did_document');
  }
}

async function loadDocument(stateFile: string): Promise<DidDocument | undefined> {
  try {
    const contents = await readFile(stateFile, 'utf8');
    return validateDidDocument(JSON.parse(contents) as unknown);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

export async function startPublisher(options: PublisherOptions): Promise<RunningPublisher> {
  let document = await loadDocument(options.stateFile);
  const server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, 200, {
        status: 'ok',
        document: document ? 'present' : 'absent',
      });
      return;
    }
    if (request.method === 'GET' && request.url === '/.well-known/did.json') {
      if (!document) {
        sendJson(
          response,
          404,
          {
            error: 'not_found',
            message: 'No DID document has been published',
          },
          { 'Access-Control-Allow-Origin': '*' },
        );
        return;
      }
      sendJson(response, 200, document, {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/did+ld+json; charset=utf-8',
      });
      return;
    }
    if (request.method === 'PUT' && request.url === '/api/did') {
      if (!hasPairingToken(request.headers.authorization, options.pairingToken)) {
        sendJson(response, 401, {
          error: 'pairing_required',
          message: 'Enter the current Publisher pairing token',
        });
        return;
      }
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim();
      if (contentType !== 'application/json') {
        sendJson(response, 415, {
          error: 'unsupported_media_type',
          message: 'Publish the DID document as application/json',
        });
        return;
      }
      void (async () => {
        let nextDocument: DidDocument;
        try {
          nextDocument = validateDidDocument(await readJsonBody(request));
        } catch (error) {
          if ((error as Error).message === 'payload_too_large') {
            sendJson(response, 413, {
              error: 'payload_too_large',
              message: 'DID document must not exceed 64 KiB',
            });
            return;
          }
          sendJson(response, 400, {
            error: 'invalid_did_document',
            message: 'DID document is invalid',
          });
          return;
        }
        try {
          await persistDocument(options.stateFile, nextDocument);
          document = nextDocument;
          response.writeHead(204, { 'Cache-Control': 'no-store' });
          response.end();
        } catch {
          sendJson(response, 500, {
            error: 'persistence_error',
            message: 'Publisher state could not be saved',
          });
        }
      })();
      return;
    }
    if (request.method === 'DELETE' && request.url === '/api/did') {
      if (!hasPairingToken(request.headers.authorization, options.pairingToken)) {
        sendJson(response, 401, {
          error: 'pairing_required',
          message: 'Enter the current Publisher pairing token',
        });
        return;
      }
      void (async () => {
        try {
          await removeDocument(options.stateFile);
          document = undefined;
          response.writeHead(204, { 'Cache-Control': 'no-store' });
          response.end();
        } catch {
          sendJson(response, 500, {
            error: 'persistence_error',
            message: 'Publisher state could not be reset',
          });
        }
      })();
      return;
    }
    const allowedMethods: Record<string, string> = {
      '/healthz': 'GET',
      '/.well-known/did.json': 'GET',
      '/api/did': 'PUT, DELETE',
    };
    const allow = request.url ? allowedMethods[request.url] : undefined;
    if (allow) {
      sendJson(
        response,
        405,
        {
          error: 'method_not_allowed',
          message: 'Method not allowed for this route',
        },
        { Allow: allow },
      );
      return;
    }
    sendJson(response, 404, { error: 'not_found', message: 'Route not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    origin: `http://${options.host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
