/**
 * Which crawlers pay, and which read free.
 *
 * Two kinds of AI crawler visit a site and only one of them ever sends a reader
 * back. RETRIEVAL crawlers feed the live index that ChatGPT search, Perplexity,
 * Bing and Siri cite from; they are welcome everywhere a reader may go.
 * TRAINING crawlers copy pages into a corpus that is baked into weights months
 * later with no link back. Those are the ones robots.txt refuses and the
 * gateway charges.
 *
 * Each entry is the token its operator documents, and the pairs are the point:
 * GPTBot vs OAI-SearchBot, ClaudeBot vs Claude-SearchBot, meta-externalagent vs
 * Meta-ExternalFetcher, Applebot-Extended vs Applebot. Refusing the wrong half
 * of a pair cuts off citations while the corpus crawl carries on.
 */

/** Training-only crawlers: refused in robots.txt, charged by the gateway. */
export const TRAINING_AGENTS = [
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'CCBot',
  'meta-externalagent',
  'FacebookBot',
  'Bytespider',
  'Applebot-Extended',
];

/**
 * Retrieval crawlers, named in robots.txt so their operators can see they are
 * welcome. Google-Extended is Google's training token but Google documents it
 * as also gating grounding in the Gemini app, so it stays on this side.
 */
export const RETRIEVAL_AGENTS = [
  'OAI-SearchBot',
  'ChatGPT-User',
  'Claude-SearchBot',
  'Claude-User',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Bingbot',
];

const lower = (list) => list.map((t) => t.toLowerCase());

/**
 * Whether a user agent is one of `agents` (default: the training list).
 *
 * Substring match on the documented token, which a determined caller can lie
 * about. That is fine and worth being clear about: this identifies a
 * self-declared corpus crawler so it can be charged. It does not stop anything
 * hostile, and a crawler wearing a browser's user agent walks straight past it.
 */
export function isTrainingAgent(userAgent = '', agents = TRAINING_AGENTS) {
  const ua = String(userAgent ?? '').toLowerCase();
  if (!ua) return false;
  return lower(agents).some((t) => ua.includes(t));
}
