import { RETRIEVAL_AGENTS, TRAINING_AGENTS } from './agents.js';

/**
 * robots.txt with the crawlers sorted the way the gateway sorts them.
 *
 * Training crawlers are refused everywhere except the page that sells them a
 * way in; retrieval crawlers are named so their operators can see they are
 * welcome; everything else gets the wildcard rules.
 *
 * The trap this avoids: a crawler that finds a group matching its own name
 * obeys THAT group and ignores `User-agent: *` entirely. Naming one and listing
 * the sign-in page only under the wildcard would invite it straight into the
 * sign-in page. So every named group repeats the rules, generated rather than
 * typed.
 *
 * @param {object} options
 * @param {string} options.siteUrl          no trailing slash
 * @param {string[]} [options.disallow]     paths nobody should index, e.g. ['/login', '/api/']
 * @param {string[]} [options.allow]        exceptions that beat a disallow by being longer, e.g. ['/api/v1']
 * @param {string} [options.sitemap]        defaults to `${siteUrl}/sitemap.xml`; '' to omit
 * @param {string} [options.path]           the sales page training crawlers may still read; default '/crawl'
 * @param {string[]} [options.refused]      extra agents refused outright, e.g. a rude SEO bot
 * @param {string[]} [options.training]     override the training list
 * @param {string[]} [options.retrieval]    override the retrieval list
 * @param {string[]} [options.comments]     lines written at the top, without the leading '# '
 */
export function robotsTxt({
  siteUrl,
  disallow = [],
  allow = [],
  sitemap,
  path = '/crawl',
  refused = [],
  training = TRAINING_AGENTS,
  retrieval = RETRIEVAL_AGENTS,
  comments = [],
} = {}) {
  if (!siteUrl) throw new Error('robotsTxt needs siteUrl');
  const base = siteUrl.replace(/\/+$/, '');
  const map = sitemap === undefined ? `${base}/sitemap.xml` : sitemap;

  const welcome = (agent) =>
    [
      `User-agent: ${agent}`,
      'Allow: /',
      ...allow.map((p) => `Allow: ${p}`),
      ...disallow.map((p) => `Disallow: ${p}`),
    ].join('\n');
  const refuse = (agent) => `User-agent: ${agent}\nDisallow: /`;
  // Longest match wins, so `Allow: /crawl` beats `Disallow: /` for that one page.
  const charge = (agent) => `${refuse(agent)}\nAllow: ${path}`;

  const lines = [
    ...comments.map((c) => `# ${c}`),
    ...(comments.length ? [''] : []),
    ...refused.map((a) => `${refuse(a)}\n`),
    ...training.map((a) => `${charge(a)}\n`),
    ...retrieval.map((a) => `${welcome(a)}\n`),
    welcome('*'),
    '',
  ];
  if (map) lines.push(`Sitemap: ${map}`, '');
  return lines.join('\n');
}
