import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import { parse as parseQuery } from 'querystring';
import {
  createResponseCache,
  ResponseCache,
  ResponseCacheOptions,
} from './response-cache/cache.js';

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

export interface HandlerOptions {
  dir: string;
  trustProxy?: boolean;
  handlerExportName?: string;
  serverModuleCandidates?: string[];
  responseCache?: ResponseCacheOptions;
}

type NodeRequestHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

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
    responseCache: cacheOptions = { enabled: false, driver: 'memory', defaultTtlSeconds: 60 },
  } = options;

  let appHandler: NodeRequestHandler | null = null;
  let responseCache: ResponseCache | null = null;

  const initialize = async (): Promise<void> => {
    if (!responseCache) {
      const driver =
        process.env.RESPONSE_CACHE_DRIVER === 'ydb' || cacheOptions.driver === 'ydb'
          ? 'ydb'
          : 'memory';

      const ydbEnabled =
        driver === 'ydb' &&
        Boolean(process.env.YDB_ENDPOINT) &&
        Boolean(process.env.YDB_DATABASE) &&
        Boolean(process.env.CACHE_BUCKET) &&
        Boolean(process.env.BUILD_ID);

      responseCache = createResponseCache({
        enabled: cacheOptions.enabled,
        driver: ydbEnabled ? 'ydb' : 'memory',
        defaultTtlSeconds: cacheOptions.defaultTtlSeconds,
        ydb: ydbEnabled
          ? {
              ydbEndpoint: process.env.YDB_ENDPOINT || '',
              ydbDatabase: process.env.YDB_DATABASE || '',
              cacheBucket: process.env.CACHE_BUCKET || '',
              buildId: process.env.BUILD_ID || 'local',
              defaultTtlSeconds: cacheOptions.defaultTtlSeconds,
            }
          : undefined,
      });
    }

    if (appHandler) {
      return;
    }

    const modulePath = resolveServerModule(dir, serverModuleCandidates);
    const imported = await import(modulePath);

    const candidate =
      (handlerExportName ? imported[handlerExportName] : undefined) ||
      imported.default ||
      imported.app ||
      imported.handler ||
      imported.render;

    if (!candidate) {
      throw new Error(`Could not find server export in ${modulePath}`);
    }

    appHandler = normalizeNodeHandler(candidate);
  };

  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
    try {
      await initialize();
      if (!appHandler || !responseCache) {
        throw new Error('Server runtime not initialized');
      }

      const cacheableRequest = shouldCacheRequest(event);
      const cacheKey = cacheableRequest ? createCacheKey(event) : null;

      if (cacheableRequest && cacheKey) {
        const cached = await responseCache.get(cacheKey);
        if (cached) {
          return {
            statusCode: cached.statusCode,
            headers: cached.headers,
            body: cached.body,
            isBase64Encoded: cached.isBase64Encoded,
          };
        }
      }

      const { req, res, responsePromise } = createNodeRequestResponse(event, trustProxy);

      await new Promise<void>((resolve, reject) => {
        const maybePromise = appHandler!(req, res);

        res.on('finish', resolve);
        res.on('error', reject);

        if (maybePromise && typeof (maybePromise as Promise<unknown>).then === 'function') {
          (maybePromise as Promise<unknown>).catch(reject);
        }
      });

      const result = await responsePromise;

      if (cacheableRequest && cacheKey && shouldCacheResponse(result)) {
        await responseCache.set(
          cacheKey,
          {
            statusCode: result.statusCode,
            headers: toStringHeaders(result.headers || {}),
            body: result.body || '',
            isBase64Encoded: result.isBase64Encoded,
          },
          {
            ttlSeconds: cacheOptions.defaultTtlSeconds || 60,
          },
        );
      }

      return result;
    } catch (error) {
      console.error('[Server] Error handling request:', error);
      return {
        statusCode: 500,
        headers: {
          'content-type': 'text/plain',
        },
        body: 'Internal Server Error',
      };
    }
  };
}

function resolveServerModule(dir: string, candidates: string[]): string {
  for (const candidate of candidates) {
    const fullPath = path.resolve(dir, candidate);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  throw new Error(`Could not resolve Angular SSR server module in ${dir}`);
}

function normalizeNodeHandler(candidate: unknown): NodeRequestHandler {
  if (typeof candidate === 'function') {
    return candidate as NodeRequestHandler;
  }

  if (candidate && typeof candidate === 'object' && 'handle' in candidate) {
    const handle = (candidate as { handle: NodeRequestHandler }).handle;
    if (typeof handle === 'function') {
      return handle.bind(candidate);
    }
  }

  throw new Error(
    'Unsupported server export shape. Expected function or object with handle(req,res).',
  );
}

function createNodeRequestResponse(event: APIGatewayProxyEventV2, trustProxy: boolean) {
  const req = new IncomingMessage(null as never) as IncomingMessage & {
    body?: unknown;
    rawBody?: string;
  };

  req.method = event.requestContext.http.method;
  req.url = event.rawPath + (event.rawQueryString ? `?${event.rawQueryString}` : '');

  req.headers = {};
  for (const [key, value] of Object.entries(event.headers || {})) {
    if (value !== undefined) {
      req.headers[key.toLowerCase()] = value;
    }
  }

  if (event.cookies && event.cookies.length > 0) {
    req.headers.cookie = event.cookies.join('; ');
  }

  const ipAddress =
    trustProxy && req.headers['x-forwarded-for']
      ? String(req.headers['x-forwarded-for']).split(',')[0].trim()
      : event.requestContext.http.sourceIp;

  Object.defineProperty(req, 'socket', {
    value: { remoteAddress: ipAddress },
    writable: true,
  });

  const responseChunks: Buffer[] = [];
  const responseHeaders: Record<string, string | string[]> = {};
  let statusCode = 200;

  const res = new ServerResponse(req) as ServerResponse;

  const responsePromise = new Promise<APIGatewayProxyResultV2>((resolve) => {
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = function (code: number, ...args: unknown[]) {
      statusCode = code;
      return originalWriteHead(code, ...(args as []));
    };

    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name: string, value: number | string | readonly string[]) {
      let normalizedValue: string | string[];
      if (Array.isArray(value)) {
        normalizedValue = value.map((item) => String(item));
      } else if (typeof value === 'number') {
        normalizedValue = String(value);
      } else if (typeof value === 'string') {
        normalizedValue = value;
      } else {
        normalizedValue = Array.from(value);
      }

      responseHeaders[name.toLowerCase()] = normalizedValue;
      return originalSetHeader(name, normalizedValue);
    };

    const originalWrite = res.write.bind(res);
    res.write = function (chunk: unknown, ...args: unknown[]) {
      if (chunk) {
        responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return originalWrite(chunk as never, ...(args as []));
    };

    const originalEnd = res.end.bind(res);
    res.end = function (chunk?: unknown, ...args: unknown[]) {
      if (chunk) {
        responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }

      const body = Buffer.concat(responseChunks);
      const contentType = responseHeaders['content-type'];
      const isBase64 = shouldBase64Encode(
        Array.isArray(contentType) ? contentType[0] : contentType,
      );

      const result: APIGatewayProxyResultV2 = {
        statusCode,
        headers: {},
        body: isBase64 ? body.toString('base64') : body.toString('utf-8'),
        isBase64Encoded: isBase64,
      };

      for (const [key, value] of Object.entries(responseHeaders)) {
        if (Array.isArray(value)) {
          result.multiValueHeaders = result.multiValueHeaders || {};
          result.multiValueHeaders[key] = value;
        } else {
          result.headers![key] = value;
        }
      }

      const setCookie = responseHeaders['set-cookie'];
      if (setCookie) {
        result.cookies = Array.isArray(setCookie) ? setCookie.map(String) : [String(setCookie)];
      }

      resolve(result);
      return originalEnd(chunk as never, ...(args as []));
    };
  });

  if (event.body) {
    const bodyBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'utf-8');

    req.rawBody = bodyBuffer.toString('utf-8');
    req.body = tryParseJson(req.rawBody);

    queueMicrotask(() => {
      req.emit('data', bodyBuffer);
      req.emit('end');
    });
  } else {
    queueMicrotask(() => {
      req.emit('end');
    });
  }

  return { req, res, responsePromise };
}

function shouldBase64Encode(contentType?: string): boolean {
  if (!contentType) {
    return false;
  }

  const textTypes = [
    'text/',
    'application/json',
    'application/xml',
    'application/javascript',
    'application/x-www-form-urlencoded',
  ];

  return !textTypes.some((type) => contentType.includes(type));
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    try {
      return parseQuery(value);
    } catch {
      return value;
    }
  }
}

function shouldCacheRequest(event: APIGatewayProxyEventV2): boolean {
  const method = event.requestContext.http.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return false;
  }

  if (event.rawPath.startsWith('/api/')) {
    return false;
  }

  const cacheControl = (event.headers['cache-control'] || '').toLowerCase();
  if (cacheControl.includes('no-cache') || cacheControl.includes('no-store')) {
    return false;
  }

  return true;
}

function shouldCacheResponse(response: APIGatewayProxyResultV2): boolean {
  if (response.statusCode !== 200) {
    return false;
  }

  const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
  return contentType.includes('text/html');
}

function createCacheKey(event: APIGatewayProxyEventV2): string {
  const vary = [
    event.headers['accept-language'] || '',
    event.headers['accept-encoding'] || '',
    event.headers['x-forwarded-host'] || event.headers.host || '',
  ].join('|');

  const hash = createHash('sha256')
    .update(`${event.requestContext.http.method}:${event.rawPath}?${event.rawQueryString}:${vary}`)
    .digest('hex');

  return `html:${hash}`;
}

function toStringHeaders(
  headers: Record<string, string | number | boolean | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      result[key] = String(value);
    }
  }
  return result;
}
