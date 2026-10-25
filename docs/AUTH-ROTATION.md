# Rotating BETTER_AUTH_SECRET

`BETTER_AUTH_SECRET` signs sessions, encrypts the OAuth signing key and, through keys derived from it, signs every link in sent emails. `SUPPRESSION_HASH_KEY` keys the never-email list. Both can be rotated without breaking MCP and OAuth clients or the links in emails already sent, if the old value is kept in `BETTER_AUTH_SECRET_PREVIOUS` (`SUPPRESSION_HASH_KEY_PREVIOUS`) while the new one signs.

## What a rotation did before

Reproduced locally before the fix, with the same flow `tests/auth-rotation.test.mjs` now runs against the fixed code: a client connects through Better Auth's OAuth provider with secret A and gets an access token and a refresh token; the deployment then runs with secret B and nothing else.

| Request, with secret B | Answer |
| --- | --- |
| `POST /mcp` with the access token the client holds | 200: tokens are checked against the public keys, which need no secret |
| `GET /api/auth/jwks` | 200: public keys only |
| `POST /api/auth/oauth2/token`, `grant_type=refresh_token` | **500 with an empty body**. The log says `Failed to decrypt private key`: the RS256 key in the `jwks` collection is encrypted with the secret that was current when it was made, and Better Auth decrypts it every time it issues a token |
| A new authorization | The browser's session cookie is signed with A, so the user is sent to `/signin`. After signing in and allowing, the code exchange at `/token` is a **500 with an empty body** again |
| Any later attempt | The same 500, until someone empties the collection by hand: the broken key is the newest one, so it is always chosen |

An access token lasts an hour. Once it expires, every client's refresh fails and, as the MCP SDK does for a `server_error`, it falls back to a new authorization: the user must reconnect, and reconnecting fails too until the key is cleaned up. This is why Claude Code and Codex lost their connections after a rotation. The collection was never cleaned up: a rotation was unsafe whenever a key existed.

The router's "The app is not answering" (502) comes from the app Worker's `fetch` throwing. The 500 above is a handled error, so it is not that. Code that could throw before: `handleAuthRequest` (a failure in `getAuth()`, e.g. a missing or malformed secret), `handleMcpRequest` (rethrew any error that was not an OAuth challenge: the signing keys or the database failing) and the API Worker's entry (rethrew). They answer JSON now (below). Which one the owner saw once is not known from here.

## What changed

- `BETTER_AUTH_SECRET_PREVIOUS`: the values `BETTER_AUTH_SECRET` had, comma-separated, newest first. Nothing is ever signed or encrypted with them. Values may not contain commas (`openssl rand -base64 48` never does).
- Better Auth gets versioned secrets (`secrets`: current first, then the previous ones; `lib/auth-secrets.js`). A version is derived from the secret's value, so nobody keeps a counter in step with the environment.
- **The signing key** (`lib/auth-keyring.js`, the jwt plugin's `adapter.getJwks`): the newest key is checked whenever keys are read. Readable with a previous secret (or written before versions existed): encrypted again with the current secret, so it survives removing the previous one. Not readable with any secret held: retired at once, one log line (`[auth] The OAuth signing key … can't be decrypted …`), and Better Auth makes a new one. A retired key's public half stays in `/api/auth/jwks` for 30 days, so access tokens already issued still verify; refresh tokens are stored hashed and need no key, so clients keep working without reconnecting.
- **Sessions and the sign-in's state cookie**: Better Auth signs cookies with the current secret only. `handleAuthRequest`, `getSession` and the server actions sign the cookies a previous secret made again with the current one, in their own copy of the request (`lib/auth-secrets.js`). Better Auth sets the cookie anew within a day of use (`session.updateAge`), signed with the current secret.
- **Links in emails**: unsubscribe, confirmation, keep, tracking (open and click), comment and referral links, pledge and gift links, the export and download links, Magic Links and referral codes are checked with the current secret and then each previous one (`lib/app-keys.js`). New links are signed with the current secret only. The `/api/internal/revalidate` route, which the API Worker calls, accepts the previous secrets too.
- **Hashes**: the status a deleted contact left behind (`lib/contacts.js`), the deletion records, and the never-email list (`SUPPRESSION_HASH_KEY_PREVIOUS`) are looked up under every secret, and written under the current one. The poll voter hash, the web analytics visitor hash and the rate-limit keys are not carried: after a rotation a web voter can vote once more and a day's unique count may repeat.
- **Failures are JSON**: `/api/auth/*` and `/.well-known/*` answer `503 {"error":"temporarily_unavailable"}` (OAuth clients keep their tokens and retry; a bare 500 makes them start over), `/mcp` answers `503 {"error":{"code":"unavailable"}}` with `retry-after: 5`, and the API Worker and the app Worker catch what would be thrown and answer the same. For a GET the router asks the app again when the API Worker answers 503.

What cannot be carried: an authorization request in flight when the new secret is set (its signed query lasts 10 minutes) starts over.

## Which Workers hold the secret

Each region (`us`, `eu`) has its own values, never shared. In a region three Workers hold both secrets and must hold the same values:

| Worker | US | EU | Config |
| --- | --- | --- | --- |
| App | `flockstack` | `flockstack-eu` | `wrangler.jsonc` (`--env eu`) |
| API (REST, MCP, OAuth endpoints) | `flockstack-api` | `flockstack-api-eu` | `workers/api/wrangler.jsonc` |
| Readers (open, click, unsubscribe, forms) | `flockstack-readers` | `flockstack-readers-eu` | `workers/readers/wrangler.jsonc` |

The router and the public pages Worker hold neither. FlockStack Cloud's website Worker is another repository's; it holds none unless it was given one. Secrets are per Worker: `wrangler secret put` on one does not reach the others.

## The procedure

Cloudflare never returns a secret's value, so the old value cannot be read from the Workers. It is typed once, hidden, and the script checks it against the live app before using it.

```bash
bash scripts/rotate-auth-secret.sh us                  # then eu; add --suppression to rotate SUPPRESSION_HASH_KEY too
node scripts/check-mcp-auth.mjs https://flockstack.io  # the script prints this line at the end
```

In this order, for the region:

1. The script asks for the current `BETTER_AUTH_SECRET` (hidden, twice) and for values still set as `BETTER_AUTH_SECRET_PREVIOUS` from an earlier rotation (comma-separated; Enter if none). It asks the live app whether the first is the value it runs with (`scripts/probe-auth-secret.mjs` sends a signature of a malformed body to `/api/internal/revalidate`; the app answers 400 for a signature it accepts and 401 otherwise, and learns nothing) and stops if the app refuses it.
2. It sets `BETTER_AUTH_SECRET_PREVIOUS` = old value (then the earlier ones) on the app, the API Worker and the readers Worker. Nothing signs differently yet.
3. It makes a new value (`openssl rand -base64 48`) and sets `BETTER_AUTH_SECRET` on the app, then the API Worker, then the readers Worker. A value that cannot be set on one is put back to the old value where it went, and the script stops.
4. Values go to `wrangler secret put` on its standard input. None is printed, written to a file or put on a command line. bash 3.2 (macOS) is enough. `--dry-run` shows the steps and asks for nothing.

Then check that clients still connect: `node scripts/check-mcp-auth.mjs <url>` (below), and open the connection in one MCP client. A client connected through OAuth should refresh without asking the user to sign in.

Later, once nothing needs the old value, take it off: `bash scripts/rotate-auth-secret.sh us --finish` (add `--suppression`). Wrangler asks to confirm each deletion. How long to wait, for `BETTER_AUTH_SECRET_PREVIOUS`:

| What it keeps working | For |
| --- | --- |
| Browser sessions | 7 days (Better Auth's default; active ones are signed again within a day) |
| The signing key | Until it is encrypted again with the new secret: the first token request or key listing after the rotation does it. Check the log for `is encrypted with the current secret now` |
| Comment links, confirmation, keep, download, export and sign-in links | 45 days at most (comment links); 90 days for keep links |
| Pledge and gift links | up to 3 years |
| **Unsubscribe links, tracking links, referral codes, Magic Links** | **They never expire.** Removing the old value breaks them in every email already sent. Keep it for as long as old emails may be opened, or accept that unsubscribe links in old emails fail (a compliance matter) |
| Deleted contacts' statuses, the never-email list | Entries made under the old value are found only while it is kept |

Several previous values can be listed, newest first; each rotation adds one, so the list grows. Without the old value (it was lost, or leaked), `--no-previous` rotates anyway: every session ends, links in sent emails stop working, OAuth clients reconnect once, and the signing key is retired and replaced on its own. It asks for the region to be typed.

By hand, the same thing, per Worker (`--env eu` for the EU app; `--config workers/api/wrangler.jsonc` or `workers/readers/wrangler.jsonc` for the others, with `--env eu` for the EU):

```bash
printf %s "$OLD" | npx wrangler secret put BETTER_AUTH_SECRET_PREVIOUS   # on all three first
printf %s "$NEW" | npx wrangler secret put BETTER_AUTH_SECRET            # then on all three, the app first
```

`scripts/set-reader-secrets.sh` and `scripts/set-api-secrets.sh` still set a new region's other values; they ask for `BETTER_AUTH_SECRET` (readers, hidden and twice) only on a first setup.

## After a deploy: the synthetic check

`node scripts/check-mcp-auth.mjs <base url>` needs no credentials and changes nothing. It checks:

- `/.well-known/oauth-authorization-server`: 200, the issuer is the site, the endpoints and `jwks_uri` are on it, S256 and the `authorization_code` and `refresh_token` grants are listed;
- `/.well-known/oauth-protected-resource` and `/mcp`: the resource is `<site>/mcp` and names the site as its authorization server;
- the `jwks_uri`: at least one RS256 key with `kid`, `n` and `e`, and no private part;
- `POST /mcp` without a token: 401 with `WWW-Authenticate: Bearer resource_metadata="<site>/.well-known/oauth-protected-resource/mcp"` and the API's `unauthorized` error.

With `FLOCKSTACK_API_KEY` in the environment (never an argument) it also lists the tools as that key. Exit code 1 when a check fails, with the status and the start of the body of the answer (that is where the router's "The app is not answering" shows). It cannot issue a token, which needs a person signing in, so it cannot see a signing key that fails to decrypt; connecting one client is that test.

`node scripts/deploy-all.mjs` runs it after each region's router is deployed, as a warning that never stops the run (it asks again after a pause; a key for the other region is not used). `--dry-run` prints what it would run.
