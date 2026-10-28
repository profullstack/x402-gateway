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
  /** The site the sale is for (option `property`, default the siteUrl hostname). */
  property?: string;
  /** The page bought: the gated URL's path, or `?from=` on the sales page. */
  resourcePath?: string | null;
  /** Keyed hash of the buyer's address (never the address). */
  ipHash?: string | null;
  /** 'x402' for a proof, 'checkout' for a CoinPay hosted checkout. */
  source?: 'x402' | 'checkout';
  network?: string | null;
  txHash?: string | null;
  /** Checkout only. */
  email?: string | null;
  accountId?: string | null;
  checkoutSessionId?: string;
  /** What was sent to CoinPay with the sale. */
  metadata?: Record<string, unknown>;
}

export interface CheckoutOptions {
  /** Key for POST /api/checkout/sessions; defaults to `coinpay.apiKey`. */
  apiKey?: string;
  baseUrl?: string;
  /** The signed-in site user, recorded as `account_id`; the buyer's email otherwise. */
  account?: (request: Request) => string | null | undefined | Promise<string | null | undefined>;
  expiresInMinutes?: number;
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
  /** Where a Power Key is bought and the header it goes in, or null when they are switched off. */
  powerKey?: { shop: string; header: string } | null;
  /** The "Buy a day pass" form, or null when CoinPay's hosted checkout is not available. */
  checkout?: { action: string; from: string; days: number } | null;
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
  /**
   * Opt-in XNO on Nano: a `nano_` (or legacy `xrb_`) payee and the price of
   * 1 XNO in `currency`, as a number or a function read per offer. Without a
   * valid payee and a positive rate the offer is USDC only. CoinPay refuses
   * Nano proofs unless its NANO_RPC_URL is set.
   */
  nano?: { payTo: string; rate: number | (() => number) };
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
  /** Charge a desktop browser string ~2 years behind its auto-updates (a scraper rotation pool). Default true. */
  chargeStaleBrowsers?: boolean;
  /** Extra agents to charge and refuse in robots.txt, e.g. AI_INDEX_AGENTS. Default none: since 0.10 the AI indexers are welcome retrieval crawlers. */
  aiIndex?: string[];
  /** Retrieval crawlers believed only from their published addresses (OpenAI, Perplexity). Default VERIFIED_RETRIEVAL; false disables. */
  verifiedRetrieval?: WelcomeCrawler[] | false;
  /** Charge a request wearing a welcome search crawler's name from outside its published ranges. Default true. */
  chargeImpostors?: boolean;
  /** Require a one-line script (cookie + reload) on these paths before serving them. Off by default. */
  /** Only GETs to `paths` that `when` accepts (default: all of them), e.g. `(req, url) => url.search.length > 1` for faceted URLs. */
  challenge?: { paths: string[]; cookie?: string; /** Proof-of-work bits the script must solve; true = 16. Default 0 (cookie + reload only). */ work?: number | boolean; /** Link a per-address stylesheet whose fetch sets `<cookie>_css`; both cookies are then required. */ css?: boolean; /** Where that stylesheet is served. Default '/__pf/c/'. */ cssPath?: string; when?: (request: Request, url: URL) => boolean } | false;
  /** SEO resellers: charged, and refused in robots.txt. Default SCRAPER_AGENTS. */
  scrapers?: string[];
  /** Headless browsers that name themselves: charged. Default HEADLESS_AGENTS. */
  headless?: string[];
  /** Search crawlers never metered when their address matches their name. Default WELCOME_CRAWLERS; false disables. */
  welcome?: WelcomeCrawler[] | false;
  /** Requests never charged, e.g. ones carrying a signed-in cookie. */
  exempt?: (request: Request) => boolean;
  /** Give a stale desktop browser string the script challenge (16-bit proof of work) on a page request instead of charging it at once; only a caller that will not run it is charged. Default true. */
  challengeStaleBrowsers?: boolean;
  /** Extra sign-in, account and payment paths never charged, appended to APP_PATHS and matched by whole segment. `false` charges APP_PATHS like any page. */
  appPaths?: string[] | false;
  /** Pass signing secret. Defaults to the CoinPay key. */
  secret?: string;
  page?: (ctx: PageContext) => string;
  contact?: string;
  /** Awaited before the buyer's receipt is sent, and its errors are swallowed: a sale is recorded, and a recording failure never costs the buyer the pass. */
  onSale?: (sale: Sale) => void | Promise<void>;
  /** The site a sale is recorded for; defaults to the siteUrl hostname. A function reads it per request (e.g. from Host). */
  property?: string | ((request: Request) => string | null | undefined);
  /** Key for the recorded address hash; defaults to the pass secret. */
  ipSalt?: string;
  /** The human checkout (CoinPay hosted, any coin or PayPal). On by default; `false` hides it. */
  checkout?: CheckoutOptions | false;
  /** Cookie a pass is also read from. Default 'crawl_pass'. */
  passCookie?: string;
  /**
   * A free allowance for ordinary callers, after which the gateway answers 402
   * with the offer instead of letting the request through. A bare number means
   * that many requests per minute. A valid pass is never metered.
   */
  freeQuota?: number | FreeQuotaOptions;
  /** What a pass unlocks, listed on the sales page and in the 402 body. */
  benefits?: string[];
  /**
   * Power Keys honoured as a pass: kid -> base64url Ed25519 public key, as
   * @profullstack/keys ships them. Defaults to Profullstack's keys, so a key
   * bought at profullstack.com/shop opens this site with no configuration.
   * `false` switches it off.
   */
  powerKeys?: Record<string, string> | false;
  /** Power Key subjects no longer honoured (refunded, leaked). */
  revokedKeys?: Iterable<string>;
  fetch?: typeof fetch;
}

export interface QuotaHit {
  /** Requests in the current window, including this one. */
  count: number;
  /** Seconds until the window rolls over. */
  resetSeconds: number;
}

/** Somewhere to count requests. Supply one to share an allowance across a fleet. */
export interface QuotaStore {
  hit(key: string, windowSeconds: number): QuotaHit | Promise<QuotaHit>;
}

export interface FreeQuotaOptions {
  /** Free requests per window. */
  requests: number;
  /** Window length. Default 60. */
  windowSeconds?: number;
  /**
   * What to count against. Defaults to the caller's address, which a rotation
   * defeats; that is answered with price rather than detection, see the README.
   */
  identify?: (request: Request) => string | null;
  /** Default: an in-process counter, so each instance grants its own allowance. */
  store?: QuotaStore;
  /** Only meter these paths or prefixes. Default: everything the gate sees. */
  paths?: string[];
}

/** An in-process fixed-window counter. */
export function memoryQuotaStore(options?: {
  now?: () => number;
  sweepEvery?: number;
}): QuotaStore & { sweep(): void; readonly size: number };

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
  extra: { name: string; version: string } | { decimals: number };
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

/** What the caller spent against an allowance, as `spend()` reports it. */
export interface QuotaUsage {
  count: number;
  remaining: number;
  resetSeconds: number;
  overLimit: boolean;
}

/** The allowance a 402 should quote, when the caller kept the count itself. */
export interface SellContext {
  usage?: QuotaUsage | null;
  /** Defaults to the gateway's own `freeQuota`. */
  quota?: { requests: number; windowSeconds: number } | null;
}

export interface Gateway {
  handle: Handle;
  sell: (request: Request, context?: SellContext) => Promise<Response>;
  enabled: boolean;
  options: Required<Omit<GatewayOptions, 'onSale' | 'fetch' | 'page' | 'isPaidAgent' | 'property' | 'checkout'>> & {
    property: GatewayOptions['property'] | null;
    checkout: CheckoutOptions | null;
    onSale: GatewayOptions['onSale'] | null;
    fetch: typeof fetch;
    page: (ctx: PageContext) => string;
    isPaidAgent: (userAgent: string) => boolean;
  };
  robotsTxt: (extra?: RobotsOptions) => string;
  page: () => string;
  /** The pass this request presents: a day pass from the gateway's header or a bearer token, or a Power Key. */
  passFrom: (request: Request) => string | null;
  /** Whether that token opens the site: a live day pass this gateway minted, or a valid, unrevoked Power Key. */
  verifyPass: (token: string | null) => Promise<boolean>;
  /** Whether the gateway's own rules charge this request (lists, spoofed or stale browser). */
  isPaid: (request: Request) => boolean;
  /** Whether this is a welcome search crawler whose address matches its name. */
  isWelcome: (request: Request) => boolean;
  /** The x402 offer this gateway would make, without answering a request. */
  offer: (days?: number) => Offer;
  /** The full 402 body around that offer: the offer plus the pass terms. */
  receipt: (days?: number, extra?: Record<string, unknown>) => Offer & Record<string, unknown>;
  /** The PAYMENT-REQUIRED header value (base64 JSON) for `days`, or null when payments are off. */
  paymentRequired: (days?: number, error?: string) => string | null;
  /** Who and where a request would be recorded as. */
  saleContext: (request: Request, source: 'x402' | 'checkout') => Promise<{ property: string; resource_path: string; user_agent: string; ip_hash: string | null; source: string }>;
  /** Whether the checkout button shows. */
  checkoutAvailable: () => Promise<boolean>;
  /** A webhook handler for CoinPay checkout events: re-reads the session from CoinPay and mints its pass. */
  checkoutWebhook: (request: Request) => Promise<Response>;
  /** Mint the pass for a paid session, from a webhook body or a session id. Null unless CoinPay says it is paid. */
  checkoutPaid: (
    bodyOrId: unknown,
    request?: Request,
  ) => Promise<{ token: string; expiresAt: string; days: number; email: string | null; accountId: string | null; ref: string } | null>;
}

export function createGateway(options: GatewayOptions): Gateway;
export function wantsHtml(accept?: string | null): boolean;

export const TRAINING_AGENTS: string[];
export const SCRAPER_AGENTS: string[];
export const HEADLESS_AGENTS: string[];
/** Sign-in, account, payment and webhook paths the gateway never charges. */
export const APP_PATHS: readonly string[];
/** Whether `path` is one of `paths` (default APP_PATHS) or below it, by whole segment. */
export function isAppPath(path: string, paths?: readonly string[]): boolean;
export const AI_INDEX_AGENTS: string[];
export function challengeToken(secret: string, ip: string, day?: number): Promise<string>;
export function passedChallenge(request: Request, options: { secret: string; cookie: string; ip: string; work?: number; css?: boolean; now?: number }): Promise<boolean>;
export function challengePage(options: { token: string; cookie: string; buyUrl: string; work?: number; cssPath?: string | null }): string;
export function stylesheetToken(secret: string, ip: string, day?: number): Promise<string>;
export function stylesheetResponse(request: Request, options: { secret: string; cookie: string; ip: string | null; cssPath: string; now?: number }): Promise<Response>;
export function solves(seed: string, nonce: string | undefined, work: number): Promise<boolean>;
export function leadingZeros(bytes: Uint8Array, bits: number): boolean;
export function cookieValue(request: Request, name: string): string | null;
export interface WelcomeCrawler {
  token: string;
  cidrs: string[];
}
export const WELCOME_CRAWLERS: WelcomeCrawler[];
export const VERIFIED_RETRIEVAL: WelcomeCrawler[];
/** The welcome crawler a request claims to be from outside its published ranges, or null. */
export function impostorCrawler(request: Request, list: WelcomeCrawler[]): string | null;
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
export function isStaleBrowser(userAgent: string, now?: number, maxMajorsBehind?: number): boolean;
export function currentMajor(browser: 'chrome' | 'firefox', now?: number): number;
export function welcomeCrawler(request: Request, list: WelcomeCrawler[] | null | undefined): string | null;
export function renderPage(ctx: PageContext): string;

export function mintPass(args: { secret: string; ref: string | null; expiresAt: number; now?: number }): Promise<{ token: string; expiresAt: number; ref: string | null }>;
export function readPass(token: string, args: { secret: string; now?: number }): Promise<{ exp: number; iat: number | null; ref: string | null } | null>;

export const METHODS: Array<{ key: string; network: string; asset: string; label: string }>;
export const X402_METHODS: typeof METHODS;
export function buildOffer(args: { payTo: string; priceCents: number; resource: string; description?: string; maxTimeoutSeconds?: number; methods?: typeof METHODS; nano?: { payTo: string; amount: string } | null }): Offer;
/** A Nano payee in canonical `nano_` form, or null. */
export function nanoPayee(address: unknown): string | null;
/** A price in raw XNO (10^30 per XNO), rounded up, at `rate` per XNO; null if either is not positive. */
export function xnoRaw(priceCents: number, rate: number): string | null;
export function decodePayment(header: string | null | undefined): Record<string, unknown> | null;
export function decodeHeader(header: string | null | undefined): Record<string, unknown> | null;
export function encodeHeader(value: unknown): string;
export function paymentRequiredHeader(offer: Offer, args?: { url?: string; description?: string; error?: string }): string;
export function paymentResponseHeader(args: { transaction?: string | null; network?: string | null; payer?: string | null }): string;
export function renderNotice(ctx: { siteName: string; siteUrl: string; buyUrl: string; title: string; body: string }): string;
export function renderPassPage(ctx: { siteName: string; siteUrl: string; buyUrl: string; token: string; expiresAt: string; days: number; header: string; cookie: string; email?: string | null }): string;
export function sessionIdFromWebhook(body: unknown): string | null;
export function expectedFor(payment: unknown, offer: Offer): { amount: string; resource: string; payTo: string; asset?: string } | null;
/** The value a proof authorizes, in the token's smallest unit, or null. */
export function paidValueOf(payment: unknown): bigint | null;
/** How many terms `value` buys at `unit` per term: a whole number in [1, maxDays], or 0. */
export function daysPaid(value: bigint | null, unit: string | number | bigint, maxDays: number): number;
export function verifyAndSettle(
  payment: unknown,
  expected: { amount: string; resource: string; payTo: string; asset?: string },
  coinpay: { apiKey: string; baseUrl: string; fetch?: typeof fetch; metadata?: Record<string, unknown> | null },
): Promise<{ ok: true; payer: string | null; ref: string | null; txHash: string | null; network: string | null } | { ok: false; reason: string; replay: boolean }>;

/** ./hono */
export function x402Gateway(gatewayOrOptions: Gateway | GatewayOptions): (c: { req: { raw: Request } }, next: () => Promise<void>) => Promise<Response | undefined>;

/** ./next */
export function x402Proxy(gatewayOrOptions: Gateway | GatewayOptions): (request: Request) => Promise<Response | undefined>;
export function robotsRoute(gateway: Gateway, extra?: RobotsOptions): () => Response;
