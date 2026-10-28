# Subfolder hosting ("mount path"): design note

Status: built, 2026-10-28 (the notes marked "Built:" say where the code went its own way). First use: a newsletter served at `https://quotesweep.com/newsletter/underwritten` from a site FlockStack does not run.

Today a newsletter's public pages live on a host: its verified `archiveHost`, else `<slug>.<shared domain>`, else `APP_URL/archive/<slug>` (`lib/archive-hosts.js`). `proxy.js` maps a host's paths onto `app/archive/[slug]/*`. A mount path adds a fourth option: the newsletter's pages at a path on the owner's own site, which forwards that path to FlockStack.

## How a request flows

1. A reader opens `https://quotesweep.com/newsletter/underwritten/p/some-issue`.
2. The owner's reverse proxy (Traefik, nginx, Caddy or a Cloudflare Worker) strips `/newsletter/underwritten` and forwards to `https://underwritten.<shared domain>/p/some-issue`, with two headers: `X-Forwarded-Host: quotesweep.com` and `X-FlockStack-Mount: <mount token>`.
3. The shared host already routes to the newsletter, so `proxy.js` needs no new host lookup. The app checks the token against the newsletter's mount (a constant-time compare of its SHA-256) and, when it matches, treats the request as mounted.
4. The response goes back through the proxy unchanged in shape; every URL in it already points at the mount path (below).

Why the shared host as the upstream: it is already routed, has a certificate and a cache, and email links keep working on it whatever the owner's proxy does.

Built: a server without a shared domain (FlockStack Cloud today) has no `<slug>.<shared domain>`, so the upstream is then `APP_URL/archive/<slug>` (`getMountUpstream`). `proxy.js` reads a mounted request's path after `/archive/<slug>` exactly as a path on the newsletter's host, so the mount's URLs have one shape (`/feed.xml`, `/p/<slug>.md`) whatever the upstream, and `worker-entry.mjs` serves `/archive/<slug>/_next/...` from the app's own files and drops a trailing slash before Next.js could redirect it. A token that doesn't match answers 403, never the 301 (which would loop through the proxy); a request that arrives with the app's own mount headers answers 400. Mounted requests skip the edge cache.

## Data

On the newsletter: `mount: { url, tokenHash, previousTokenHash, previousUntil, verifiedAt }`. `url` is https, a public host, no query or fragment, a path of one to three segments. One mount per newsletter. An `archiveHost` and a mount cannot both be set. The token is shown once when the mount is set (as webhook secrets are) and can be rotated, with the previous one accepted for 24 hours.

Actions: `set_newsletter_mount` (url → token, shown once), `check_newsletter_mount` (FlockStack fetches `<url>/.well-known/flockstack-mount` through the owner's site and expects its own signed answer, proving the proxy forwards with the token), `rotate_newsletter_mount_token`, `remove_newsletter_mount`. Same registry, dashboard, REST and MCP parity as every action. Built: set and rotate are class admin (a credential, like a webhook secret), check is write, remove is destructive; no index changed, so no migration.

## URLs

`getArchiveUrls` (every page, feed, sitemap, robots, llms.txt, podcast, shop, offer, gift, perks, sign-in, account link) uses the mount URL as its base when the mount is verified. Archive pages are cached once for every host, and the base depends only on the newsletter, so the cache stays correct.

`getLinkBaseUrl` does not change: the links in emails (open pixel, click, unsubscribe, confirmation) stay on the FlockStack host. An email already sent must keep working even if the owner's proxy breaks or the mount is removed.

Canonical and Open Graph URLs point at the mount path. On the shared host, a GET for an HTML page without a valid mount token answers 301 to the same page under the mount path, so search engines see one address. The email link endpoints, `/api/*`, `/embed.js` and assets never redirect.

## What the browser loads

Root-relative URLs in the HTML (`/_next/static/...`, `/api/visit`, `/api/views`, form actions) would hit the owner's own site, and on a Next.js site like QuoteSweep's they would collide with its own `/_next/`. Two changes cover it:

- When the request is mounted, the app Worker passes HTML responses through `HTMLRewriter` and prefixes the mount path to root-relative `href`, `src`, `srcset`, `action` and `formaction` values. The proxy forwards everything under the prefix, so `/newsletter/underwritten/_next/static/...` reaches FlockStack.
- Client code on reader pages that calls `fetch("/...")` reads a base from `document.documentElement.dataset.base` instead. The audit found `components/ReaderTranslation.jsx`; the archive's beacon scripts and the signup form script are checked in the build.

## Cookies

Reader sign-in and Subscriber Center cookies are set host-only (no `Domain`) with `Path` set to the mount path when mounted, so they belong to the owner's site under that path and never to the rest of `quotesweep.com`. `SameSite=Lax` stays.

Built: a reader's sign-in link from an email (`/reader/in`, `/reader/signin`) stays on the FlockStack host like every email link, and once the mount is verified it goes on (303) to the same path under the mount, where the session's cookies are set. Unsubscribe, tracking and confirmation links never do.

## The owner's proxy

The docs give one recipe each for Traefik (a `PathPrefix` router with `StripPrefix` and a `Headers` middleware adding the two headers, service URL the shared host with `passHostHeader: false`), nginx, Caddy and a Cloudflare Worker route. The token is a secret on the owner's side, stored in the proxy's secret store, not in a committed file.

## Until it ships

For Underwritten the web archive stays off and issues go by email only, so no URL has to change later. The sending domain is a separate concern (its own SES identity on a `quotesweep.com` subdomain, not `mail.quotesweep.com`).

## Tests

URL builders with and without a mount; email links never use the mount; redirect from the shared host without a token and none with it; the rewriter on a sample page (assets, forms, srcset, an absolute link left alone, `//cdn` left alone); cookie path; token rotation; the check endpoint; parity tests for the three actions.
