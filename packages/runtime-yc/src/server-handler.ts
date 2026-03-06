import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import fs from 'fs';

/* ------------------------------------------------------------------ */
/*  Yandex Cloud Functions event / response types                     */
/* ------------------------------------------------------------------ */

export interface APIGatewayProxyEventV2 {
  version: string;
  routeKey: string;
  rawPath: string;
  rawQueryString: string;
  headers: Record<string, string | undefined>;
  cookies?: string[];
  requestContext: {
    accountId: string;
    apiId: string;
    domainName: string;
    domainPrefix: string;
    http: {
      method: string;
      path: string;
      protocol: string;
      sourceIp: string;
      userAgent: string;
    };
    requestId: string;
    routeKey: string;
    stage: string;
    time: string;
    timeEpoch: number;
  };
  body?: string;
  isBase64Encoded?: boolean;
}

export interface APIGatewayProxyResultV2 {
  statusCode: number;
  headers?: Record<string, string | number | boolean>;
  multiValueHeaders?: Record<string, Array<string | number | boolean>>;
  body?: string;
  isBase64Encoded?: boolean;
  cookies?: string[];
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export interface HandlerOptions {
  dir: string;
  trustProxy?: boolean;
  handlerExportName?: string;
  serverModuleCandidates?: string[];
  /** @deprecated Caching is temporarily disabled while handler is simplified. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  responseCache?: any;
}

type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

interface AngularEngine {
  handle(request: Request): Promise<Response | null>;
}

export function createServerHandler(options: HandlerOptions) {
  const {
    dir,
    trustProxy = true,
    handlerExportName,
    serverModuleCandidates = [
      'server/server.mjs',
      'server/server.js',
      'server/main.server.mjs',
      'server/main.server.js',
      'server.mjs',
      'server.js',
      'server/index.mjs',
      'server/index.js',
      'server/main.mjs',
      'server/main.js',
      'main.server.mjs',
      'main.server.js',
    ],
  } = options;

  const debug = Boolean(process.env.AYC_DEBUG);

  let engine: AngularEngine | null = null;
  let nodeHandler: NodeRequestHandler | null = null;

  const initialize = async (): Promise<void> => {
    if (engine || nodeHandler) return;

    const modulePath = resolveServerModule(dir, serverModuleCandidates);
    if (debug) console.log(`[Server] Loading module: ${modulePath}`);
    const imported = await import(modulePath);
    if (debug) console.log(`[Server] Module exports: ${Object.keys(imported).join(', ')}`);

    // Prefer AngularAppEngine — works with Web Request/Response, no Node shim needed.
    const EngineClass = imported.AngularAppEngine;
    if (typeof EngineClass === 'function') {
      try {
        engine = new EngineClass() as AngularEngine;
        if (debug) console.log('[Server] Using AngularAppEngine (Web API path)');
      } catch {
        if (debug) console.log('[Server] AngularAppEngine instantiation failed, using Node path');
      }
    }

    // Node handler as fallback (API routes, or full Express app if no engine).
    const candidate =
      (handlerExportName ? imported[handlerExportName] : undefined) ||
      imported.reqHandler ||
      imported.app ||
      imported.handler ||
      imported.default ||
      imported.render;

    if (candidate) {
      nodeHandler = normalizeNodeHandler(candidate);
      if (debug) console.log(`[Server] Node handler resolved (type: ${typeof candidate})`);
    }

    if (!engine && !nodeHandler) {
      throw new Error(`Could not find a usable server export in ${modulePath}`);
    }
  };

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    const startTime = Date.now();
    try {
      await initialize();

      const method = event.requestContext?.http?.method || 'GET';
      const urlPath = event.rawPath || '/';
      if (debug) {
        console.log(`[Server] ${method} ${urlPath} (+${Date.now() - startTime}ms)`);
      }

      // API routes → Node handler (Express) directly, skip Angular SSR.
      if (urlPath.startsWith('/api/') && nodeHandler) {
        if (debug) console.log(`[Server] API route → Node handler`);
        return await handleViaNode(nodeHandler, event, trustProxy);
      }

      // SSR pages → AngularAppEngine with Web Request/Response.
      if (engine) {
        const webRequest = buildWebRequest(event, trustProxy);
        const response = await engine.handle(webRequest);

        if (response) {
          const result = await toYCResponse(response);
          if (debug) console.log(`[Server] ${result.statusCode} (+${Date.now() - startTime}ms)`);
          return result;
        }
      }

      // Fallback: Node handler for anything the engine didn't match.
      if (nodeHandler) {
        if (debug) console.log(`[Server] Fallback → Node handler`);
        return await handleViaNode(nodeHandler, event, trustProxy);
      }

      return {
        statusCode: 404,
        headers: { 'content-type': 'text/plain' },
        body: 'Not Found',
        isBase64Encoded: false,
      };
    } catch (error) {
      console.error('[Server] Error handling request:', error);
      return {
        statusCode: 500,
        headers: { 'content-type': 'text/plain' },
        body: 'Internal Server Error',
        isBase64Encoded: false,
      };
    }
  };
}

/* ------------------------------------------------------------------ */
/*  Web Request / Response helpers                                    */
/* ------------------------------------------------------------------ */

function buildWebRequest(event: APIGatewayProxyEventV2, trustProxy: boolean): Request {
  const headers = event.headers ?? {};

  const host = trustProxy
    ? headers['x-forwarded-host'] || headers['host'] || 'localhost'
    : headers['host'] || 'localhost';

  const proto = trustProxy ? headers['x-forwarded-proto'] || 'https' : 'https';

  const urlPath = event.rawPath || '/';
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : '';
  const url = `${proto}://${host}${urlPath}${qs}`;

  const reqHeaders = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value != null) reqHeaders.set(key, value);
  }
  if (event.cookies?.length) {
    reqHeaders.set('cookie', event.cookies.join('; '));
  }

  const method = event.requestContext.http.method;
  const hasBody = !['GET', 'HEAD'].includes(method) && event.body;

  let body: string | Buffer | undefined;
  if (hasBody) {
    body = event.isBase64Encoded ? Buffer.from(event.body!, 'base64') : event.body!;
  }

  return new Request(url, { method, headers: reqHeaders, body });
}

async function toYCResponse(response: Response): Promise<APIGatewayProxyResultV2> {
  const responseHeaders: Record<string, string> = {};
  const cookies: string[] = [];

  response.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'set-cookie') {
      cookies.push(value);
    } else {
      responseHeaders[key] = value;
    }
  });

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const contentType = responseHeaders['content-type'] || '';
  const isBase64 = shouldBase64Encode(contentType);

  const result: APIGatewayProxyResultV2 = {
    statusCode: response.status,
    headers: responseHeaders,
    body: isBase64 ? buffer.toString('base64') : buffer.toString('utf-8'),
    isBase64Encoded: isBase64,
  };

  if (cookies.length > 0) {
    result.cookies = cookies;
  }

  return result;
}

/* ------------------------------------------------------------------ */
/*  Node.js fallback (API routes / legacy handlers)                   */
/* ------------------------------------------------------------------ */

function handleViaNode(
  handler: NodeRequestHandler,
  event: APIGatewayProxyEventV2,
  trustProxy: boolean,
): Promise<APIGatewayProxyResultV2> {
  return new Promise((resolve, reject) => {
    const req = new IncomingMessage(null as never);
    req.method = event.requestContext.http.method;
    req.url = event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : '');

    req.headers = {};
    for (const [key, value] of Object.entries(event.headers || {})) {
      if (value !== undefined) req.headers[key.toLowerCase()] = value;
    }
    if (event.cookies?.length) {
      req.headers.cookie = event.cookies.join('; ');
    }

    const ip =
      trustProxy && req.headers['x-forwarded-for']
        ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
        : event.requestContext.http.sourceIp;

    Object.defineProperty(req, 'socket', {
      value: { remoteAddress: ip },
      writable: true,
    });

    const chunks: Buffer[] = [];
    const resHeaders: Record<string, string | string[]> = {};
    let statusCode = 200;

    const res = new ServerResponse(req);

    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = function (code: number, ...args: unknown[]) {
      statusCode = code;
      return origWriteHead(code, ...(args as []));
    };

    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name: string, value: number | string | readonly string[]) {
      const v = Array.isArray(value) ? value.map(String) : String(value);
      resHeaders[name.toLowerCase()] = v;
      return origSetHeader(name, v);
    };

    const origWrite = res.write.bind(res);
    res.write = function (chunk: unknown, ...args: unknown[]) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return origWrite(chunk as never, ...(args as []));
    };

    const origEnd = res.end.bind(res);
    res.end = function (chunk?: unknown, ...args: unknown[]) {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));

      const body = Buffer.concat(chunks);
      const ct = resHeaders['content-type'];
      const isBase64 = shouldBase64Encode(Array.isArray(ct) ? ct[0] : ct);

      const result: APIGatewayProxyResultV2 = {
        statusCode,
        headers: {},
        body: isBase64 ? body.toString('base64') : body.toString('utf-8'),
        isBase64Encoded: isBase64,
      };

      for (const [key, value] of Object.entries(resHeaders)) {
        if (Array.isArray(value)) {
          result.multiValueHeaders = result.multiValueHeaders || {};
          result.multiValueHeaders[key] = value;
        } else {
          result.headers![key] = value;
        }
      }

      const setCookie = resHeaders['set-cookie'];
      if (setCookie) {
        result.cookies = Array.isArray(setCookie) ? setCookie.map(String) : [String(setCookie)];
      }

      resolve(result);
      return origEnd(chunk as never, ...(args as []));
    };

    res.on('error', reject);

    // Emit body asynchronously (matches Express expectations).
    if (event.body) {
      const buf = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64')
        : Buffer.from(event.body, 'utf-8');
      queueMicrotask(() => {
        req.emit('data', buf);
        req.emit('end');
      });
    } else {
      queueMicrotask(() => req.emit('end'));
    }

    const maybePromise = handler(req, res);
    if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
      (maybePromise as Promise<unknown>).catch(reject);
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Shared utilities                                                  */
/* ------------------------------------------------------------------ */

function resolveServerModule(dir: string, candidates: string[]): string {
  for (const candidate of candidates) {
    const fullPath = path.resolve(dir, candidate);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  throw new Error(`Could not resolve Angular SSR server module in ${dir}`);
}

function normalizeNodeHandler(candidate: unknown): NodeRequestHandler {
  if (typeof candidate === 'function') return candidate as NodeRequestHandler;

  if (candidate && typeof candidate === 'object' && 'handle' in candidate) {
    const handle = (candidate as { handle: NodeRequestHandler }).handle;
    if (typeof handle === 'function') return handle.bind(candidate);
  }

  throw new Error(
    'Unsupported server export shape. Expected function or object with handle(req,res).',
  );
}

function shouldBase64Encode(contentType?: string): boolean {
  if (!contentType) return false;
  const textTypes = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-www-form-urlencoded',
  ];
  return !textTypes.some((type) => contentType.includes(type));
}
