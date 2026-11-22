# Changelog

## 0.18.4 (2026-11-22)

Sitemaps are always readable. `/sitemap.xml`, `/sitemap-<part>.xml`, `/sitemap_index.xml` (and `.xml.gz`)
and anything under `/sitemaps/` join `robots.txt` in the open paths, so a refused crawler that
follows the `Sitemap:` line in robots.txt reads the sitemap instead of a 402.

## 0.18.3 (2026-11-22)

**Security.** A session cookie that is merely present no longer has to be an exemption.

Every Profullstack site passed `exempt: (r) => cookie.includes('<site>_session=')`. Any client can
send that header, so `Cookie: <site>_session=x` let GPTBot and every other declared crawler read
free, past the challenge and the free allowance.

- New option `sessionCookie` (string, RegExp, a synchronous `(request) => boolean` predicate, or an
  array of these): the site's session cookie name, or any unverified signed-in signal (a token's
  shape). Its presence is a hint, not a pass. Such a request is not charged for a suspect (stale or
  spoofed) browser string, so a signed-in person on an old browser still reads. Declared crawlers
  and impostors are still charged, and the challenge, `denyCidrs`, `massScrape` and the quotas all
  still apply. A forged cookie buys exactly what a modern browser string would.
- `exempt` is now awaited, so a site can verify a session (a signature or a database lookup).
  It must verify. Move any cookie-presence `exempt` to `sessionCookie`.
