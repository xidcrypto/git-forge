// The forge's HTTP plumbing: one server, four surfaces over one store (store.ts). This file owns
// the wire concerns the adapters should not see — body reading, the bearer-token check, JSON
// parsing (a malformed body is a 400 before any routing), the X-GitHub-Request-Id header on REST
// answers, and the guarantee that a bad request (a garbage pack, a broken negotiation) is an
// error answer, never a dead server. The surfaces themselves live in rest.ts, git.ts,
// graphql.ts and mcp.ts.
//
// The token's owner: the harness presents one fixed identity for the trial (the scenario's
// viewer), and every repository belongs to that login; another owner reads as a 404, never a 403.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack, type WireAnswer } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The login the trial's token belongs to (the scenario's viewer). */
const VIEWER_LOGIN = 'adaiversen';

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `req-${requestSeq}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendWire(res: ServerResponse, answer: WireAnswer): void {
  res.writeHead(answer.status, { 'content-type': answer.contentType, 'content-length': answer.body.length });
  res.end(answer.body);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The bearer check: with a token configured, only `Bearer <token>` passes; without one, all do. */
function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on port 0. */
export function createApp(): Server {
  const store = new Store(VIEWER_LOGIN);
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(store, req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
}

async function handle(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  // The env's boot check: 200 {"ok":true}, no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP at /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    await handleGit(store, req, res, url, gitMatch);
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = (await readBody(req)).toString('utf8');
    const answer = handleMcp(store, raw);
    if (answer.body === undefined) {
      res.writeHead(answer.status);
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' });
      return;
    }
    const raw = await readBody(req);
    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' });
      return;
    }
    const answer = executeGraphQL(store, payload);
    sendJson(res, answer.status, answer.body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const headers = { 'x-github-request-id': nextRequestId() };
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Bad credentials' }, headers);
      return;
    }
    let body: Record<string, unknown> | undefined;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          const parsed = JSON.parse(raw.toString('utf8')) as unknown;
          body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, headers);
          return;
        }
      }
    }
    const segments = path.split('/').filter((segment) => segment !== '').slice(2).map(decodeSegment);
    const answer = handleRest(store, {
      method,
      segments,
      query: url.searchParams,
      body,
      host: req.headers.host ?? 'entry',
    });
    const answerHeaders = { ...headers, ...(answer.headers ?? {}) };
    if (answer.status === 204 || answer.body === undefined) {
      res.writeHead(answer.status, answerHeaders);
      res.end();
      return;
    }
    sendJson(res, answer.status, answer.body, answerHeaders);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** One git smart-HTTP exchange; a malformed body is an error answer, never a crash. */
async function handleGit(store: Store, req: IncomingMessage, res: ServerResponse, url: URL, match: RegExpExecArray): Promise<void> {
  const owner = decodeSegment(match[1] as string);
  const repoName = decodeSegment(match[2] as string);
  const action = match[3] as string;
  if (!authorized(req)) {
    sendText(res, 401, 'unauthorized');
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === null) {
    sendText(res, 404, 'not found');
    return;
  }
  const protocolV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (action === 'info/refs') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendText(res, 400, 'service required');
      return;
    }
    sendWire(res, infoRefs(repo, service, protocolV2));
    return;
  }
  const body = await readBody(req);
  try {
    const answer = action === 'git-upload-pack' ? uploadPack(repo, body, protocolV2) : await receivePack(repo, body);
    sendWire(res, answer);
  } catch {
    sendText(res, 400, 'bad request');
  }
}
