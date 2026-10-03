import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Local transport: HTTP + Server-Sent Events bound to 127.0.0.1, authenticated with a
// per-daemon bearer token written to <dataDir>/daemon.json (readable only by the user).

export interface DaemonInfo {
  pid: number;
  port: number;
  token: string;
  /** Authorizes GET routes only: what a browser page (the telemetry dashboard) is handed. */
  readToken?: string;
  startedAt: string;
  dataDir: string;
}

export function daemonInfoPath(dataDir: string): string {
  return join(dataDir, 'daemon.json');
}

export function readDaemonInfo(dataDir: string): DaemonInfo | null {
  const p = daemonInfoPath(dataDir);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as DaemonInfo;
  } catch {
    return null;
  }
}

export interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  req: IncomingMessage;
  res: ServerResponse;
}

export type Handler = (ctx: RequestContext) => unknown | Promise<unknown>;

export class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  public: boolean;
}

export class LocalServer {
  private readonly routes: Route[] = [];
  private server: Server | null = null;
  readonly token = randomBytes(24).toString('hex');
  readonly readToken = randomBytes(24).toString('hex');

  /** A route; `public` ones (a static page) need no token, every other needs one. */
  route(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}): this {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    this.routes.push({ method, pattern, keys, handler, public: opts.public ?? false });
    return this;
  }

  async listen(port: number, dataDir: string): Promise<DaemonInfo> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    const info: DaemonInfo = {
      pid: process.pid,
      port: typeof addr === 'object' && addr ? addr.port : port,
      token: this.token,
      readToken: this.readToken,
      startedAt: new Date().toISOString(),
      dataDir,
    };
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(daemonInfoPath(dataDir), JSON.stringify(info, null, 2), { mode: 0o600 });
    return info;
  }

  async close(dataDir?: string): Promise<void> {
    if (dataDir) rmSync(daemonInfoPath(dataDir), { force: true });
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
  }

  /** The full token authorizes everything; the read token GETs only. */
  private authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.replace(/^Bearer /, ''));
    const is = (token: string) => {
      const want = Buffer.from(token);
      return given.length === want.length && timingSafeEqual(given, want);
    };
    return is(this.token) || (req.method === 'GET' && is(this.readToken));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      const route = this.routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (url.pathname !== '/health' && !route?.public && !this.authorized(req)) throw new HttpError(401, 'unauthorized');
      if (!route) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
      const m = route.pattern.exec(url.pathname)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      const body = req.method === 'GET' ? undefined : await readBody(req);
      const out = await route.handler({ params, query: url.searchParams, body, req, res });
      if (res.headersSent) return; // streaming handler
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out ?? { ok: true }));
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err instanceof HttpError ? err.status : 400;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 5 * 1024 * 1024) throw new HttpError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/** Start a Server-Sent Events stream on `res`. Returns a writer and registers cleanup. */
export function sse(res: ServerResponse, onClose: () => void): (event: string, data: unknown, id?: number) => void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  res.write(': connected\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  res.on('close', () => {
    clearInterval(ping);
    onClose();
  });
  return (event, data, id) => {
    res.write(`${id !== undefined ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

/** Client used by the CLI and any other local consumer. */
export class CockpitClient {
  constructor(private readonly info: DaemonInfo) {}

  static fromDataDir(dataDir: string): CockpitClient {
    const info = readDaemonInfo(dataDir);
    if (!info) throw new Error(`orchestrator daemon is not running (no ${daemonInfoPath(dataDir)}); start it with "cockpit daemon"`);
    return new CockpitClient(info);
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.info.port}`;
  }

  async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { authorization: `Bearer ${this.info.token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`cannot reach orchestrator at ${this.baseUrl}; is "cockpit daemon" running?`);
    }
    const json = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    return json;
  }

  /** Follow the event stream; resolves when aborted. */
  async follow(path: string, onEvent: (event: string, data: unknown) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(this.baseUrl + path, { headers: { authorization: `Bearer ${this.info.token}`, accept: 'text/event-stream' }, signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) onEvent(ev, JSON.parse(data));
        }
      }
    } catch (err) {
      if (!signal?.aborted) throw err;
    }
  }
}
