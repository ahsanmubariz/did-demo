import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import express, { type RequestHandler } from 'express';
import QRCode from 'qrcode';
import {
  createEmployeeCredential,
  employeeClaimNames,
  employeeTypeMetadata,
  ISSUER_DID,
  RP_DID,
  type DisclosureSalts,
  type EmployeeClaims,
  RP_CLIENT_ID,
  verifyEmployeePresentation,
} from '../src/credentials/sd-jwt';
import { verifyCredentialProof } from '../src/credentials/issuance';
import { createAuthorizationRequest } from '../src/credentials/authorization-request';
import { sha256 } from '@noble/hashes/sha2.js';
import { createStatusListToken } from '../src/credentials/status-list';
import {
  DID,
  jwkThumbprint,
  publicJwkFromUncompressed,
  validateDidDocument,
  type DidDocument,
  type PublicP256Jwk,
} from '../src/wallet/did-profile';
import { persistDocument, removeDocument } from '../publisher/file-store';
import { CompanionDatabase } from './database';
import { PUBLIC_PROFILE } from '../src/config/public-profile';

type RoleKeys = {
  issuer: string;
  relyingParty: string;
};

export type CompanionOptions = {
  host: string;
  port: number;
  stateDirectory: string;
  operatorToken: string;
  staticDirectory?: string;
  publicOrigin?: string;
};

export type RunningCompanion = {
  origin: string;
  close(): Promise<void>;
};

function newSecret(): Uint8Array {
  while (true) {
    const candidate = randomBytes(32);
    if (p256.utils.isValidSecretKey(candidate)) return candidate;
  }
}

async function loadRoleKeys(stateDirectory: string): Promise<{
  issuer: Uint8Array;
  relyingParty: Uint8Array;
}> {
  await mkdir(stateDirectory, { recursive: true });
  const keyPath = join(stateDirectory, 'role-keys.json');
  try {
    const stored = JSON.parse(await readFile(keyPath, 'utf8')) as RoleKeys;
    const issuer = base64urlnopad.decode(stored.issuer);
    const relyingParty = base64urlnopad.decode(stored.relyingParty);
    if (
      !p256.utils.isValidSecretKey(issuer) ||
      !p256.utils.isValidSecretKey(relyingParty)
    ) {
      throw new Error('invalid_role_keys');
    }
    return { issuer, relyingParty };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const issuer = newSecret();
    const relyingParty = newSecret();
    await writeFile(
      keyPath,
      `${JSON.stringify(
        {
          issuer: base64urlnopad.encode(issuer),
          relyingParty: base64urlnopad.encode(relyingParty),
        } satisfies RoleKeys,
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    return { issuer, relyingParty };
  }
}

function roleDocument(
  did: typeof ISSUER_DID | typeof RP_DID,
  secret: Uint8Array,
  relationship: 'assertionMethod' | 'authentication',
) {
  const publicKeyJwk: PublicP256Jwk = publicJwkFromUncompressed(
    p256.getPublicKey(secret, false),
  );
  const keyId = `${did}#${jwkThumbprint(publicKeyJwk)}`;
  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/jws-2020/v1',
    ],
    id: did,
    verificationMethod: [
      {
        id: keyId,
        type: 'JsonWebKey2020',
        controller: did,
        publicKeyJwk,
      },
    ],
    [relationship]: [keyId],
  };
}

function authorized(value: string | undefined, expected: string): boolean {
  return value === `Bearer ${expected}`;
}

function opaqueToken(bytes = 24): string {
  return base64urlnopad.encode(randomBytes(bytes));
}

function numericCode(): string {
  const value = randomBytes(4).readUInt32BE(0) % 1_000_000;
  return value.toString().padStart(6, '0');
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1];
}

function digest(value: string): string {
  return base64urlnopad.encode(sha256(new TextEncoder().encode(value)));
}

const employeeClaims: EmployeeClaims = {
  name: 'Alya Pratama',
  email: 'alya.pratama@employee.test',
  employee_id: 'EMP-DEMO-001',
  department: 'Digital Trust Lab',
  employer: 'PERURI',
  employment_status: 'active',
};

async function loadHolderDocument(path: string): Promise<DidDocument | undefined> {
  try {
    return validateDidDocument(JSON.parse(await readFile(path, 'utf8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

export async function startCompanion(
  options: CompanionOptions,
): Promise<RunningCompanion> {
  const keys = await loadRoleKeys(options.stateDirectory);
  const database = new CompanionDatabase(join(options.stateDirectory, 'demo.sqlite'));
  const holderDocumentPath = join(options.stateDirectory, 'holder-did.json');
  let holderDocument = await loadHolderDocument(holderDocumentPath);
  const issuerDocument = roleDocument(ISSUER_DID, keys.issuer, 'assertionMethod');
  const rpDocument = roleDocument(RP_DID, keys.relyingParty, 'authentication');
  const nonces = new Map<string, number>();
  const rateBuckets = new Map<string, { openedAt: number; count: number }>();
  let serviceOrigin = options.publicOrigin ?? '';
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  const rateLimit = (scope: string, maximum: number): RequestHandler => (
    request,
    response,
    next,
  ) => {
    const now = Date.now();
    const key = `${scope}:${request.ip}`;
    const current = rateBuckets.get(key);
    const bucket =
      !current || now - current.openedAt >= 60_000
        ? { openedAt: now, count: 0 }
        : current;
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > maximum) {
      response
        .set({ 'Retry-After': '60', 'Cache-Control': 'no-store' })
        .status(429)
        .json({ error: 'rate_limited' });
      return;
    }
    next();
  };

  app.get('/healthz', (_request, response) => {
    response
      .set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      .json({
        status: 'ok',
        database: 'ready',
        holderDocument: holderDocument ? 'present' : 'absent',
      });
  });
  app.get('/.well-known/did.json', (_request, response) => {
    if (!holderDocument) {
      response
        .set({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
        .status(404)
        .json({
          error: 'not_found',
          message: 'No DID document has been published',
        });
      return;
    }
    response
      .set({
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/did+ld+json',
      })
      .json(holderDocument);
  });
  app.put('/api/did', async (request, response) => {
    if (!authorized(request.headers.authorization, options.operatorToken)) {
      response.status(401).json({
        error: 'operator_required',
        message: 'Enter the current Companion Web Operator Token',
      });
      return;
    }
    try {
      const document = validateDidDocument(request.body);
      if (
        holderDocument &&
        holderDocument.authentication[0] !== document.authentication[0] &&
        database.hasActiveCredential(Math.floor(Date.now() / 1000))
      ) {
        response.status(409).json({
          error: 'active_credential_blocks_rotation',
          message: 'Revoke or remove the active credential before rotating the DID key',
        });
        return;
      }
      await persistDocument(holderDocumentPath, document);
      holderDocument = document;
      response.set({ 'Cache-Control': 'no-store' }).status(204).end();
    } catch {
      response.status(400).json({
        error: 'invalid_did_document',
        message: 'DID document is invalid',
      });
    }
  });
  app.delete('/api/did', async (request, response) => {
    if (!authorized(request.headers.authorization, options.operatorToken)) {
      response.status(401).json({
        error: 'operator_required',
        message: 'Enter the current Companion Web Operator Token',
      });
      return;
    }
    await removeDocument(holderDocumentPath);
    holderDocument = undefined;
    response.set({ 'Cache-Control': 'no-store' }).status(204).end();
  });
  app.get('/issuer/did.json', (_request, response) => {
    response
      .set({
        'Cache-Control': 'public, max-age=300',
        'Content-Type': 'application/did+ld+json',
      })
      .json(issuerDocument);
  });
  app.get('/rp/did.json', (_request, response) => {
    response
      .set({
        'Cache-Control': 'public, max-age=300',
        'Content-Type': 'application/did+ld+json',
      })
      .json(rpDocument);
  });
  app.get('/credentials/employee/v1', (_request, response) => {
    response
      .set({ 'Cache-Control': 'public, max-age=300' })
      .json(employeeTypeMetadata);
  });
  app.get('/status/employee', (_request, response) => {
    const now = Math.floor(Date.now() / 1000);
    response
      .type('application/statuslist+jwt')
      .set({ 'Cache-Control': 'public, max-age=30' })
      .send(
        createStatusListToken({
          issuerSecret: keys.issuer,
          issuerKeyId: issuerDocument.assertionMethod![0] as string,
          uri: PUBLIC_PROFILE.employeeStatusListUri,
          statuses: database.credentialStatuses(),
          now,
        }),
      );
  });
  app.get('/api/qr', async (request, response) => {
    const uri = request.query.uri;
    if (
      typeof uri !== 'string' ||
      uri.length > 2048 ||
      !uri.startsWith(`${serviceOrigin}/`)
    ) {
      response.status(400).json({ error: 'invalid_qr_reference' });
      return;
    }
    const svg = await QRCode.toString(uri, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      margin: 1,
      color: { dark: '#10251f', light: '#fffdf7' },
    });
    response
      .type('image/svg+xml')
      .set({
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'",
        'X-Content-Type-Options': 'nosniff',
      })
      .send(svg);
  });
  app.get('/.well-known/openid-credential-issuer', (_request, response) => {
    response.set({ 'Cache-Control': 'no-store' }).json({
      credential_issuer: serviceOrigin,
      token_endpoint: `${serviceOrigin}/oid4vci/token`,
      credential_endpoint: `${serviceOrigin}/oid4vci/credential`,
      nonce_endpoint: `${serviceOrigin}/oid4vci/nonce`,
      notification_endpoint: `${serviceOrigin}/oid4vci/notification`,
      credential_configurations_supported: {
        EmployeeCredential: {
          format: 'dc+sd-jwt',
          vct: employeeTypeMetadata.vct,
          cryptographic_binding_methods_supported: ['jwk'],
          credential_signing_alg_values_supported: ['ES256'],
          display: employeeTypeMetadata.display,
        },
      },
    });
  });
  app.post('/api/operator/offers', rateLimit('offers', 20), (request, response) => {
    if (!authorized(request.headers.authorization, options.operatorToken)) {
      response.status(401).json({
        error: 'operator_required',
        message: 'Enter the current Companion Web Operator Token',
      });
      return;
    }
    if (!holderDocument) {
      response.status(409).json({
        error: 'holder_did_required',
        message: 'Publish the wallet DID before creating an offer',
      });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const id = opaqueToken(16);
    const preAuthorizedCode = opaqueToken();
    const transactionCode = numericCode();
    database.createExchange({
      id,
      kind: 'issuance',
      state: 'offered',
      expiresAt: now + 5 * 60,
      data: { preAuthorizedCode, transactionCode },
    });
    response.status(201).set({ 'Cache-Control': 'no-store' }).json({
      id,
      credentialOfferUri: `${serviceOrigin}/issuer/offers/${id}`,
      transactionCode,
    });
  });
  app.get('/issuer/offers/:id', (request, response) => {
    const exchange = database.getExchange(request.params.id);
    const now = Math.floor(Date.now() / 1000);
    if (!exchange || exchange.kind !== 'issuance' || exchange.expiresAt <= now) {
      response.status(404).json({ error: 'invalid_offer' });
      return;
    }
    response.set({ 'Cache-Control': 'no-store' }).json({
      credential_issuer: serviceOrigin,
      credential_configuration_ids: ['EmployeeCredential'],
      grants: {
        'urn:ietf:params:oauth:grant-type:pre-authorized_code': {
          'pre-authorized_code': exchange.data.preAuthorizedCode,
          tx_code: {
            input_mode: 'numeric',
            length: 6,
            description: 'Enter the demo code shown separately by the issuer.',
          },
        },
      },
    });
  });
  app.get('/issuer/offers/:id/status', (request, response) => {
    const exchange = database.getExchange(request.params.id);
    if (!exchange || exchange.kind !== 'issuance') {
      response.status(404).json({ error: 'invalid_offer' });
      return;
    }
    response.set({ 'Cache-Control': 'no-store' }).json({ state: exchange.state });
  });
  app.post('/oid4vci/token', rateLimit('token', 30), (request, response) => {
    const preAuthorizedCode = request.body?.['pre-authorized_code'];
    const exchange =
      typeof preAuthorizedCode === 'string'
        ? database.findExchangeByData('preAuthorizedCode', preAuthorizedCode)
        : undefined;
    const now = Math.floor(Date.now() / 1000);
    if (
      exchange?.kind === 'issuance' &&
      exchange.expiresAt > now &&
      request.body?.tx_code === exchange.data.transactionCode &&
      typeof exchange.data.accessToken === 'string'
    ) {
      response.set({ 'Cache-Control': 'no-store' }).json({
        access_token: exchange.data.accessToken,
        token_type: 'Bearer',
        expires_in: Math.max(1, exchange.expiresAt - now),
      });
      return;
    }
    if (
      request.body?.grant_type !==
        'urn:ietf:params:oauth:grant-type:pre-authorized_code' ||
      !exchange ||
      exchange.kind !== 'issuance' ||
      exchange.state !== 'offered' ||
      exchange.expiresAt <= now ||
      request.body?.tx_code !== exchange.data.transactionCode
    ) {
      response.status(400).json({ error: 'invalid_grant' });
      return;
    }
    const accessToken = opaqueToken();
    database.updateExchange(exchange.id, 'authorized', {
      ...exchange.data,
      accessToken,
    });
    response.set({ 'Cache-Control': 'no-store' }).json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: Math.max(1, exchange.expiresAt - now),
    });
  });
  app.post('/oid4vci/nonce', (_request, response) => {
    const nonce = opaqueToken(16);
    nonces.set(nonce, Math.floor(Date.now() / 1000) + 60);
    response.set({ 'Cache-Control': 'no-store' }).json({
      c_nonce: nonce,
      c_nonce_expires_in: 60,
    });
  });
  app.post('/oid4vci/credential', (request, response) => {
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    const exchange = bearer
      ? database.findExchangeByData('accessToken', bearer)
      : undefined;
    const now = Math.floor(Date.now() / 1000);
    const proof = request.body?.proof;
    if (
      exchange?.kind === 'issuance' &&
      ['issued', 'accepted'].includes(exchange.state) &&
      exchange.expiresAt > now &&
      request.body?.credential_configuration_id === 'EmployeeCredential' &&
      typeof exchange.data.compact === 'string' &&
      typeof exchange.data.notificationId === 'string'
    ) {
      response.set({ 'Cache-Control': 'no-store' }).json({
        credentials: [{ credential: exchange.data.compact }],
        notification_id: exchange.data.notificationId,
      });
      return;
    }
    if (
      !exchange ||
      exchange.kind !== 'issuance' ||
      exchange.state !== 'authorized' ||
      exchange.expiresAt <= now ||
      request.body?.credential_configuration_id !== 'EmployeeCredential' ||
      proof?.proof_type !== 'jwt' ||
      typeof proof.jwt !== 'string' ||
      !holderDocument
    ) {
      response.status(400).json({ error: 'invalid_credential_request' });
      return;
    }
    try {
      const proofPayload = proof.jwt.split('.')[1];
      if (!proofPayload) throw new Error('invalid_credential_proof');
      const decoded = JSON.parse(
        new TextDecoder().decode(base64urlnopad.decode(proofPayload)),
      ) as { nonce?: unknown };
      const nonce =
        typeof decoded.nonce === 'string' ? decoded.nonce : undefined;
      if (!nonce || (nonces.get(nonce) ?? 0) <= now) {
        throw new Error('invalid_credential_proof');
      }
      verifyCredentialProof({
        jwt: proof.jwt,
        holderDocument,
        audience: serviceOrigin,
        nonce,
        now,
      });
      nonces.delete(nonce);
      const statusIndex = database.nextStatusIndex();
      const salts = Object.fromEntries(
        employeeClaimNames.map((name) => [name, opaqueToken(16)]),
      ) as DisclosureSalts;
      const issued = createEmployeeCredential({
        issuerSecret: keys.issuer,
        issuerKeyId: issuerDocument.assertionMethod![0] as string,
        holderDid: DID,
        holderJwk: holderDocument.verificationMethod[0].publicKeyJwk,
        claims: employeeClaims,
        salts,
        now,
        status: {
          idx: statusIndex,
          uri: PUBLIC_PROFILE.employeeStatusListUri,
        },
      });
      const credentialId = opaqueToken(16);
      const notificationId = opaqueToken(16);
      database.insertCredential({
        id: credentialId,
        holderDid: DID,
        compact: issued.compact,
        statusIndex,
        issuedAt: now,
        expiresAt: now + 7 * 24 * 60 * 60,
      });
      database.updateExchange(exchange.id, 'issued', {
        ...exchange.data,
        credentialId,
        notificationId,
        compact: issued.compact,
      });
      response.set({ 'Cache-Control': 'no-store' }).json({
        credentials: [{ credential: issued.compact }],
        notification_id: notificationId,
      });
    } catch {
      response.status(400).json({ error: 'invalid_proof' });
    }
  });
  app.post('/oid4vci/notification', (request, response) => {
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    const notificationId = request.body?.notification_id;
    const exchange =
      typeof notificationId === 'string'
        ? database.findExchangeByData('notificationId', notificationId)
        : undefined;
    if (
      bearer &&
      exchange?.state === 'accepted' &&
      exchange.data.accessToken === bearer &&
      request.body?.event === 'credential_accepted'
    ) {
      response.status(204).end();
      return;
    }
    if (
      !bearer ||
      !exchange ||
      exchange.data.accessToken !== bearer ||
      exchange.state !== 'issued' ||
      request.body?.event !== 'credential_accepted'
    ) {
      response.status(400).json({ error: 'invalid_notification' });
      return;
    }
    database.updateExchange(exchange.id, 'accepted', exchange.data, {
      acceptedAt: Math.floor(Date.now() / 1000),
    });
    response.status(204).end();
  });
  app.post('/api/rp/requests', rateLimit('rp-requests', 20), (_request, response) => {
    const now = Math.floor(Date.now() / 1000);
    const id = opaqueToken(16);
    const state = opaqueToken(16);
    const nonce = opaqueToken(16);
    const browserBinding = opaqueToken(24);
    database.createExchange({
      id,
      kind: 'presentation',
      state: 'awaiting_wallet',
      expiresAt: now + 5 * 60,
      data: {
        state,
        nonce,
        browserBindingHash: digest(browserBinding),
      },
    });
    const secure = serviceOrigin.startsWith('https://') ? '; Secure' : '';
    response
      .status(201)
      .set({
        'Cache-Control': 'no-store',
        'Set-Cookie': `rp_demo_binding=${browserBinding}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=600`,
      })
      .json({
        id,
        requestUri: `${serviceOrigin}/rp/requests/${id}`,
      });
  });
  app.get('/rp/requests/:id', (request, response) => {
    const exchange = database.getExchange(request.params.id);
    const now = Math.floor(Date.now() / 1000);
    if (
      !exchange ||
      exchange.kind !== 'presentation' ||
      exchange.expiresAt <= now
    ) {
      response.status(404).json({ error: 'invalid_request_uri' });
      return;
    }
    const requestObject = createAuthorizationRequest({
      rpSecret: keys.relyingParty,
      rpKeyId: rpDocument.authentication![0] as string,
      responseUri: `${serviceOrigin}/oid4vp/direct_post`,
      nonce: String(exchange.data.nonce),
      state: String(exchange.data.state),
      now,
    });
    response
      .type('application/oauth-authz-req+jwt')
      .set({ 'Cache-Control': 'no-store' })
      .send(requestObject);
  });
  app.post('/oid4vp/direct_post', rateLimit('direct-post', 30), (request, response) => {
    const state = request.body?.state;
    const exchange =
      typeof state === 'string'
        ? database.findExchangeByData('state', state)
        : undefined;
    const now = Math.floor(Date.now() / 1000);
    if (
      !exchange ||
      exchange.kind !== 'presentation' ||
      exchange.expiresAt <= now
    ) {
      response.status(400).json({ error: 'invalid_request' });
      return;
    }
    if (['granted', 'denied'].includes(exchange.state)) {
      response.set({ 'Cache-Control': 'no-store' }).json({
        redirect_uri: `${serviceOrigin}/partner/result/${exchange.id}`,
      });
      return;
    }
    if (request.body?.error === 'access_denied') {
      database.updateExchange(
        exchange.id,
        'denied',
        exchange.data,
        { category: 'holder_declined' },
        now + 10 * 60,
      );
      database.addAudit(now, 'denied', 'holder_declined');
      response.set({ 'Cache-Control': 'no-store' }).json({
        redirect_uri: `${serviceOrigin}/partner/result/${exchange.id}`,
      });
      return;
    }
    if (typeof request.body?.vp_token !== 'string') {
      response.status(400).json({ error: 'invalid_presentation' });
      return;
    }
    try {
      const verified = verifyEmployeePresentation({
        presentation: request.body.vp_token,
        issuerJwk: issuerDocument.verificationMethod[0]!.publicKeyJwk,
        expectedAudience: RP_CLIENT_ID,
        expectedNonce: String(exchange.data.nonce),
        now,
      });
      if (!database.isCredentialActive(verified.status.idx, now)) {
        response.status(400).json({ error: 'credential_not_active' });
        return;
      }
      if (
        verified.disclosed.employer !== 'PERURI' ||
        verified.disclosed.employment_status !== 'active'
      ) {
        response.status(403).json({ error: 'access_policy_denied' });
        return;
      }
      const disclosed = {
        name: verified.disclosed.name,
        employer: verified.disclosed.employer,
        employment_status: verified.disclosed.employment_status,
      };
      database.updateExchange(
        exchange.id,
        'granted',
        { ...exchange.data, disclosed, accessExpiresAt: now + 10 * 60 },
        { category: 'access_granted' },
        now + 10 * 60,
      );
      database.addAudit(now, 'granted', 'employee_access');
      response.set({ 'Cache-Control': 'no-store' }).json({
        redirect_uri: `${serviceOrigin}/partner/result/${exchange.id}`,
      });
    } catch {
      database.updateExchange(exchange.id, 'failed', exchange.data, {
        category: 'presentation_invalid',
      });
      database.addAudit(now, 'failed', 'presentation_invalid');
      response.status(400).json({ error: 'invalid_presentation' });
    }
  });
  app.get('/api/rp/requests/:id', (request, response) => {
    const exchange = database.getExchange(request.params.id);
    const binding = cookieValue(request.headers.cookie, 'rp_demo_binding');
    if (
      !exchange ||
      exchange.kind !== 'presentation' ||
      !binding ||
      digest(binding) !== exchange.data.browserBindingHash
    ) {
      response.status(403).json({ error: 'browser_binding_required' });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (exchange.state === 'granted') {
      response.set({ 'Cache-Control': 'no-store' }).json({
        state: 'granted',
        disclosed: exchange.data.disclosed,
        accessExpiresIn: Math.max(
          0,
          Number(exchange.data.accessExpiresAt) - now,
        ),
      });
      return;
    }
    if (exchange.state === 'denied') {
      response.set({ 'Cache-Control': 'no-store' }).json({
        state: 'denied',
        reason: 'Wallet holder declined this request.',
      });
      return;
    }
    response.set({ 'Cache-Control': 'no-store' }).json({
      state: exchange.expiresAt <= now ? 'expired' : exchange.state,
    });
  });
  app.get('/api/operator/summary', (request, response) => {
    if (!authorized(request.headers.authorization, options.operatorToken)) {
      response.status(401).json({
        error: 'operator_required',
        message: 'Enter the current Companion Web Operator Token',
      });
      return;
    }
    response
      .set({ 'Cache-Control': 'no-store' })
      .json(database.summary(Math.floor(Date.now() / 1000)));
  });
  app.post('/api/operator/credentials/active/revoke', (request, response) => {
    if (!authorized(request.headers.authorization, options.operatorToken)) {
      response.status(401).json({
        error: 'operator_required',
        message: 'Enter the current Companion Web Operator Token',
      });
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    if (!database.revokeActiveCredential(now)) {
      response.status(404).json({ error: 'active_credential_not_found' });
      return;
    }
    database.addAudit(now, 'revoked', 'credential_lifecycle');
    response.status(204).end();
  });
  app.post('/api/operator/reset', async (request, response) => {
    if (!authorized(request.headers.authorization, options.operatorToken)) {
      response.status(401).json({
        error: 'operator_required',
        message: 'Enter the current Companion Web Operator Token',
      });
      return;
    }
    database.resetDemo();
    await removeDocument(holderDocumentPath);
    holderDocument = undefined;
    nonces.clear();
    response.status(204).end();
  });

  if (options.staticDirectory) {
    app.use(express.static(options.staticDirectory, { index: false }));
    app.use((request, response, next) => {
      if (
        request.method !== 'GET' ||
        request.path.startsWith('/api/') ||
        !request.accepts('html')
      ) {
        next();
        return;
      }
      response.sendFile(join(options.staticDirectory!, 'index.html'));
    });
  }
  app.use((_request, response) => {
    response.status(404).json({ error: 'not_found', message: 'Route not found' });
  });

  const server = createServer(app);
  await listen(server, options.port, options.host);
  const address = server.address() as AddressInfo;
  const localOrigin = `http://${options.host}:${address.port}`;
  serviceOrigin ||= localOrigin;
  return {
    origin: localOrigin,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          database.close();
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
