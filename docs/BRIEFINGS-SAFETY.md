# Briefings: fetcher safety review

Status: review of 2026-10-29, with the gaps it found fixed in the same change. It checks the rules in `docs/BRIEFINGS-DESIGN.md` (Fetching, Safety) against every request the Briefings engine makes. Line numbers are as of this change.

## The rules

1. Public hosts only: no private, loopback, link-local, carrier-grade NAT, documentation, multicast or reserved address, however it is written (decimal, octal, hex, short IPv4, IPv4-mapped, IPv4-compatible, NAT64, 6to4, Teredo).
2. The name resolved and every address checked before connecting, again on every redirect hop.
3. Size and time caps on every fetch: 1 MB and 8 s for pages, 100 KB for robots.txt, 2 MB and 60 s for a model's answer.
4. robots.txt read before every page fetch, for the host of each hop, with the honest user agent `FlockStack-Briefings/1.0 (+https://flockstack.io/docs/briefings-bot)`.
5. No stealth: no cookies, one user agent, no proxies, no archive or cache copies; a 401, 403 or 429 is final.
6. The briefing's blocked hosts honoured everywhere a host is fetched, cited or shown.
7. Rate limits: two at a time per host, 300 fetches per run, 3 runs an hour per account, and a fetch allowance per account across all its briefings.

## Where each rule is enforced

| Rule | Where |
| - | - |
| Private address forms | `getPrivateHostProblem` (`lib/webhook-url.js:112`, ranges at `:11`, IPv6 at `:45`), called by `getFeedUrlProblem` (`lib/feed-url.js:7`), `getLinkProblem` (`lib/link-check-rules.js:10`), `getAiBaseUrlProblem` (`lib/ai-keys.js:60`). The URL parser turns decimal, octal, hex and short IPv4 into dotted form first, so they reach the same check. |
| Resolved addresses | `createResolver` (`lib/briefings/fetch.js:35`: DNS over HTTPS in a Worker, `dns.lookup` on Node), `assertPublic` (`fetch.js:203`, every address, cached per run), `getAddressProblem` (`fetch.js:54`); on Node again at connect time in `publicLookup` (`lib/briefings/node-fetch.js:10`). |
| Every redirect hop | `get` (`fetch.js:297`) and `checkLink` (`fetch.js:322`) follow redirects by hand with `redirect: "manual"` (`fetch.js:244`), each hop through `checkAddress` (`fetch.js:288`: URL rule, blocked hosts, addresses, robots.txt). `loadRobots` (`fetch.js:258`) holds robots.txt redirects to the same rules. Provider APIs (`api`, `fetch.js:362`) and model servers (`postJson`, `lib/briefings/providers.js:114`) don't follow redirects at all. |
| Size and time | `timeLimit` and `readBytes` (`fetch.js:77`, `:90`): one timer from the moment a request is sent covers the headers and the body, whether or not the fetch stops a body on its signal; past the byte cap the body is cancelled. Model answers: `CALL_LIMITS.bytes` (`providers.js:12`, read at `:150`), error bodies 4 KB (`:97`). |
| robots.txt | `allowedByRobots` (`fetch.js:282`), rules and cache in `lib/briefings/robots.js` (24 h, an unreachable file disallows for an hour); an oversize file is read to its first 100 KB (`fetch.js:276`). |
| No stealth | `send` (`fetch.js:228`): one user agent, `credentials: "omit"`; `FINAL_STATUSES` (`fetch.js:14`). TinyFish is asked only for a page our own fetch read but couldn't use as text (`lib/briefings/extract.js:80`). |
| Blocked hosts | `assertPublic` on every hop (`fetch.js:203`); candidates (`lib/briefings/discovery/index.js:211`), followed links (`:282`), primary links (`extract.js:19`), the provider's fetch and its final address (`discovery/index.js:353`, `:377`), preview images (`extract.js:150`, `:225`, `lib/briefings/stages.js:218`). |
| Rate limits | `withHost` and `perRun` (`fetch.js:12`); `TICK.runsPerAccountHour` (`lib/briefings/index.js:26`); `ACCOUNT_FETCH_LIMITS` (`lib/briefing-rules.js:52`) through `reserveFetches` (`lib/briefings/discovery/pacing.js:57`), wired at `index.js:268` and `:339`; provider pacing `takeSlot` (`pacing.js:35`). |

## Every network path

| Path | Public host | Every hop | Size and time | robots.txt | Blocked hosts | Before this change |
| - | - | - | - | - | - | - |
| Pages (extract, dating brief items, followed links, outlet home pages and feeds) through `fetcher.get` | yes | yes | yes | yes, each hop's host | yes | a body that kept trickling was only stopped if fetchImpl honoured its signal |
| Draft links (`check.js:42`, `:100`) through `fetcher.checkLink` | yes (http allowed, default ports) | yes | 6 s, body never read | yes | yes | ok |
| robots.txt itself | yes | yes, up to 5 | 100 KB, 8 s | n/a | yes | an oversize file was dropped and read as "allow everything"; a redirect to one briefing's blocked host was cached as "disallow" for every briefing for an hour |
| GDELT, Hacker News Algolia, TinyFish Search and Fetch, candidate feed (`discovery/*.js` through `ctx.fetchImpl` = `fetcher.api`) | yes, and the candidate feed's address also at save time (`ai-keys.js:60`) and before `check_ai_key` (`ai-keys.js:189`) | no redirects followed | yes (TinyFish Fetch 60 s) | no: these are documented APIs, not crawling | yes | a body that kept trickling wasn't stopped |
| TinyFish Fetch's target page (`providerFetcher`, `discovery/index.js:364`) | yes (URL rule; the host's robots.txt read is held to the address rule) | the provider follows redirects itself: its final address is now checked | n/a (TinyFish's network) | yes, and now for the final address too | yes, and now for the final address too | the final address after TinyFish's redirects wasn't checked against robots.txt or blocked hosts |
| Model providers (`callModel`, `callTypeSafe`) | fixed public endpoints, or an OpenAI-compatible `baseUrl` checked at save (`ai-keys.js:60`), at use (`providers.js:53`) and resolved before every request (`guard` = `assertPublic`) | no redirects followed | 60 s; now 2 MB | n/a | yes (guard) | the answer was read whole with `response.json()`, so a server the account pointed at could send an unbounded body |
| DNS over HTTPS (`fetch.js:35`) | fixed `cloudflare-dns.com` | n/a | 8 s | n/a | n/a | ok |
| Example URLs in the brief | checked with the webhook rule when saved (`lib/actions/briefings.js:446`) | never fetched: only their words go to the models | n/a | n/a | n/a | ok |
| Preview images (og:image) | not fetched by the server; the owner's browser loads them on the run and verdict pages (`components/ImageLinkPreview.jsx`, no referrer) | n/a | n/a | n/a | now yes | a page could name an image inside the owner's own network (a router, localhost) or on a blocked host, and the owner's browser would request it |
| Workers AI embeddings, `BriefingsDelivery` | bindings, not fetches | | | | | ok |

## Gaps found and fixed

1. **IPv6 ranges that reach IPv4 or aren't public:** NAT64 local-use `64:ff9b:1::/48`, Teredo `2001::/32`, site-local `fec0::/10`, discard-only `100::/64` were treated as public (`lib/webhook-url.js`). This rule is shared, so webhooks, feeds and link checks are now stricter too.
2. **Slow bodies:** the 8 s cap covered a body only through the fetch's own signal. `timeLimit` now races the headers and every read against one timer started when the request is sent.
3. **Model answers had no size cap**, and error bodies were read whole before being cut to 4 KB. Answers are now capped at 2 MB within the 60 s, error bodies at 4 KB.
4. **robots.txt over 100 KB** made the reader drop the file and allow everything. It now parses the first 100 KB (RFC 9309 asks a reader to parse at least 500 KiB; FlockStack reads less and errs towards the rules at the top). A file that stalls counts as unreachable, which disallows the host for an hour.
5. **One briefing's blocked host leaked into the shared robots.txt cache** as an hour's "disallow" for every other briefing. That answer is no longer kept.
6. **TinyFish Fetch's final address**, after its own redirects, wasn't held to robots.txt or the blocked hosts. It is now, and the provider is never asked for an address our own fetch may not open (http, private, blocked).
7. **Preview images** could point the owner's browser into a private network, at a port, or at a blocked host. Those are no longer recorded.
8. **No account-wide fetch limit:** 300 fetches a run and 3 runs an hour bounded an account only indirectly. `ACCOUNT_FETCH_LIMITS` is now 600 fetches an hour and 3,000 a day per account, across all its briefings and runs (pages, robots.txt files and draft links), reserved 10 at a time in `DiscoveryUsage` (provider `fetcher`). A fetch past it fails like the run cap: the page is skipped and a draft link is "unsure". Reserved fetches a tick didn't use are lost, so the allowance errs on the side of fewer fetches.
9. **DNS rebinding on a self-hosted Node server:** the name was checked with `dns.lookup`, then Node's fetch looked it up again to connect, so a name with a zero TTL could answer the check publicly and the connection privately (a cloud's metadata address, the server's own network). The engine's default fetch on Node is now `createPinnedFetch` (`lib/briefings/node-fetch.js`), which checks every address in the lookup the connection itself uses, and refuses an address written as one. The self-hosted cron no longer hands in the plain `fetch`.

## Residual risk

- **DNS rebinding in a Worker.** A Worker can't resolve a name or pin a connection: the check asks Cloudflare's DNS over HTTPS, and `fetch()` resolves again on its own. A name with a zero TTL can pass the check and resolve elsewhere for the connection. What that reaches is limited: the briefings Worker has no VPC or Tunnel binding, so a Worker's fetch exits to the public Internet and a private address has no route from it; a Cloudflare address is refused by the platform (error 1024). `global_fetch_strictly_public` (set in `workers/briefings/wrangler.jsonc`) only makes a fetch to one of our own zones go through the front door instead of the origin; it is not an address filter. If a VPC, Tunnel or Workers VPC binding is ever added to this Worker, this risk becomes real and the fetches need an egress filter there.
- **Rebinding on Node between hops** is closed by the pinned fetch, but a self-hosted server that hands `runTick` its own `fetchImpl` gives that up.
- **http links in drafts** are checked with plain http (a reader's link can be http), so their robots.txt (read only over https) is never readable and they come back "unsure".
- **Provider APIs aren't read for robots.txt.** GDELT, Algolia, TinyFish and the candidate feed are documented APIs called as their terms allow; robots.txt governs crawling pages.
- **TinyFish fetches from its own network.** What it reads before its final address is out of our view; we only refuse to use the result.
- **Preview images still load from the publisher's host** in the owner's browser, which tells that host the owner's IP address (no referrer is sent). Proxying them would make FlockStack fetch them instead.
- **The allowance undercounts what's left:** reservations a tick didn't use are lost when it ends (at most 9 per run per tick). Each reservation is one atomic increment, so two briefings reserving at once can't both be granted the same fetches.
