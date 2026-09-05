/** A Fetch-API request handler that answers, or returns null to let the request through. */
export type Handle = (request: Request) => Promise<Response | null>;

export interface Sale {
  payer: string | null;
  ref: string | null;
  token: string;
  expiresAt: string;
  userAgent: string;
  /** Per term (`passMinutes`). */
  priceCents: number;
  /** Terms this proof bought. */
  days: number;
  /** `priceCents * days`. */
  totalCents: number;
  currency: string;
}

export interface PageContext {
  siteName: string;
  siteUrl: string;
  buyUrl: string;
  /** Per day, e.g. "1.00 USD". */
  price: string;
  minutes: number;
  /** Days this page's offer quotes (`?days=`), 1 by default. */
  days: number;
  /** `price` times `days`. */
  total: string;
  maxDays: number;
  header: string;
  enabled: boolean;
  offer: Offer;
  training: string[];
  retrieval: string[];
  contact: string;
}

export interface GatewayOptions {
  /** Canonical origin, no trailing slash. */
  siteUrl: string;
  /** Shown on the sales page; defaults to the hostname. */
  siteName?: string;
  /** A SCOPED CoinPay key (cp_live_… from the business's API Keys tab) with payments:create. */
  coinpay?: { apiKey?: string; baseUrl?: string };
  /** EVM address that receives the USDC. */
  payTo?: string;
  /** Default 100 ($1). */
  priceCents?: number;
  currency?: string;
  /** What one price buys. Default 1440 (a day). */
  passMinutes?: number;
  /** The most terms one proof may buy at once (`?days=` and paid multiples are clamped to it). Default 30. */
  maxDays?: number;
  /** Request header the pass is presented in. Default 'x-crawl-pass'. */
  header?: string;
  /** The sales page. Default '/crawl'. */
  path?: string;
  /** Extra paths a refused crawler may still read. */
  openPaths?: string[];
  training?: string[];
  retrieval?: string[];
  /** Who is charged. Default: the training list, substring-matched on the user agent. */
  isPaidAgent?: (userAgent: string) => boolean;
  /** IPv4 CIDRs answered 403 before anything else (a VPS fleet's provider ranges). */
  denyCidrs?: string[];
  /** Charge a request that claims "Chrome/…" but lacks the Sec-Fetch-Mode header every Chromium sends. Default false. */
  chargeSpoofedBrowsers?: boolean;
  /** Requests never charged, e.g. ones carrying a signed-in cookie. */
  exempt?: (request: Request) => boolean;
  /** Pass signing secret. Defaults to the CoinPay key. */
  secret?: string;
  page?: (ctx: PageContext) => string;
  contact?: string;
  onSale?: (sale: Sale) => void | Promise<void>;
  fetch?: typeof fetch;
}

export interface AcceptEntry {
  scheme: 'exact';
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

export interface Offer {
  x402Version: 2;
  accepts: AcceptEntry[];
}

export interface RobotsOptions {
  siteUrl?: string;
  disallow?: string[];
  allow?: string[];
  sitemap?: string;
  path?: string;
  refused?: string[];
  training?: string[];
  retrieval?: string[];
  comments?: string[];
}

export interface Gateway {
  handle: Handle;
  sell: (request: Request) => Promise<Response>;
  enabled: boolean;
  options: Required<Omit<GatewayOptions, 'onSale' | 'fetch' | 'page' | 'isPaidAgent'>> & {
    onSale: GatewayOptions['onSale'] | null;
    fetch: typeof fetch;
    page: (ctx: PageContext) => string;
    isPaidAgent: (userAgent: string) => boolean;
  };
  robotsTxt: (extra?: RobotsOptions) => string;
  page: () => string;
}

export function createGateway(options: GatewayOptions): Gateway;
export function wantsHtml(accept?: string | null): boolean;

export const TRAINING_AGENTS: string[];
export const RETRIEVAL_AGENTS: string[];
export function isTrainingAgent(userAgent?: string | null, agents?: string[]): boolean;

export function robotsTxt(options: RobotsOptions & { siteUrl: string }): string;

/** ./edge (also re-exported from the root) */
export interface Cidr { base: number; mask: number; text: string }
export function parseCidr(cidr: string): Cidr | null;
export function compileCidrs(list?: string[]): Cidr[];
export function inCidrs(ip: string, compiled: Cidr[]): boolean;
export function clientIp(request: Request): string;
export function isSpoofedBrowser(request: Request): boolean;
export function renderPage(ctx: PageContext): string;

export function mintPass(args: { secret: string; ref: string | null; expiresAt: number; now?: number }): Promise<{ token: string; expiresAt: number; ref: string | null }>;
export function readPass(token: string, args: { secret: string; now?: number }): Promise<{ exp: number; iat: number | null; ref: string | null } | null>;

export const METHODS: Array<{ key: string; network: string; asset: string; label: string }>;
export const X402_METHODS: typeof METHODS;
export function buildOffer(args: { payTo: string; priceCents: number; resource: string; description?: string; maxTimeoutSeconds?: number; methods?: typeof METHODS }): Offer;
export function decodePayment(header: string | null | undefined): Record<string, unknown> | null;
export function expectedFor(payment: unknown, offer: Offer): { amount: string; resource: string; payTo: string; asset: string } | null;
/** The value a proof authorizes, in the token's smallest unit, or null. */
export function paidValueOf(payment: unknown): bigint | null;
/** How many terms `value` buys at `unit` per term: a whole number in [1, maxDays], or 0. */
export function daysPaid(value: bigint | null, unit: string | number | bigint, maxDays: number): number;
export function verifyAndSettle(
  payment: unknown,
  expected: { amount: string; resource: string; payTo: string; asset: string },
  coinpay: { apiKey: string; baseUrl: string; fetch?: typeof fetch },
): Promise<{ ok: true; payer: string | null; ref: string | null } | { ok: false; reason: string; replay: boolean }>;

/** ./hono */
export function x402Gateway(gatewayOrOptions: Gateway | GatewayOptions): (c: { req: { raw: Request } }, next: () => Promise<void>) => Promise<Response | undefined>;

/** ./next */
export function x402Proxy(gatewayOrOptions: Gateway | GatewayOptions): (request: Request) => Promise<Response | undefined>;
export function robotsRoute(gateway: Gateway, extra?: RobotsOptions): () => Response;
