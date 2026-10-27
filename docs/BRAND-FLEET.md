# Brand fleet

`/fleet` shows all newsletters in the signed-in account. The same data is available through `get_brand_fleet` (`GET /api/v1/fleet`). A key limited to one newsletter cannot read the whole fleet or set up account-wide domains.

## Newsletter limits

| Plan | Newsletters |
| --- | ---: |
| Free | 1 |
| Starter | 3 |
| Growth | 5 |
| Pro | 10 |
| Scale | 25 |
| Max | 50 |

An admin can raise one account's limit from **Change limits** on `/admin`, including a fleet owner's account: for example, 100 newsletters. This saves `limitOverrides.newsletters`; leaving it empty uses the plan's number. The override grants no additional emails or subscribers. A downgrade keeps every newsletter and refuses new ones until the account is below its limit. A self-hosted server has no newsletter limit.

No account receives an override automatically, and this build does not change a production account.

## Automatic DNS

The server operator sets `CLOUDFLARE_API_TOKEN` with DNS Read and DNS Write on the approved zones, and assigns domains to accounts through `CLOUDFLARE_FLEET_ZONES`. This configuration belongs on each app and API Worker that serves the account, in its own region. It is not needed on the readers Worker. Do not put real account IDs, tokens or zone configuration in this public repository.

The value is a JSON array, for example:

```json
[{"accountId":"000000000000000000000001","domain":"example.com","zoneId":"00000000000000000000000000000001"}]
```

The domain must be exactly the approved sending domain, within that zone. Its archive hostname must be within that brand domain. Use a separate entry for a sending subdomain. An API caller cannot supply a zone ID or use another account's approved domain.

`onboard_brand_domains` (`POST /api/v1/fleet/domains`) takes up to 10 domains:

```json
{"domains":[{"domain":"example.com","archiveHost":"news.example.com"}]}
```

It uses the existing `add_domain` / `check_domain` path for Amazon SES identities and Cloudflare for SaaS archive hosts. It creates DKIM CNAMEs, return-path MX and SPF, DMARC, and the archive CNAME and certificate-validation records where configured. CNAMEs are DNS-only. Existing matching records are reused; a valid existing or inherited DMARC policy is kept. Conflicting SPF, MX or CNAME records are refused for review, never overwritten. All of a domain's records are checked for conflicts before any DNS record is created.

Each domain returns `ready`, `pending` or `error`, with the records created or reused. `pending` means SES or DNS/certificate verification has not completed. An error can leave a claimed domain, provider identity or some DNS records; those stay so a retry can continue. Retrying does not replace records. The next domain in a batch still runs. A batch containing any unapproved domain is rejected before provider or DNS work starts.

This action sends no email, creates no campaign and does not change a newsletter's From address. After verification, switch its sender on `/domains` or through `update_newsletter`. Send-with-approval keys require approval for provisioning; drafts and read-only keys cannot provision domains. Calls share an account limit of three batches per hour.

Cloudflare's record fields: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/create/

## Metrics and brakes

The fleet reports active subscriptions per newsletter, its last sent issue (imported sent issues included), and sent messages, bounces and complaints over the last seven days, with `asOf` and the raw counts. Rates are fractions of sent messages and are null with no sends. Campaign, last-chance, welcome, confirmation, referral and automation messages count; tests and purchase/comment notifications do not. Subscription totals count a reader separately for every list they joined.

A bounce or complaint event checks that newsletter's own rates at the account's pause levels, including the stricter Free levels and their minimum counts. Reaching a level latches `sendingBrake` and pauses its sending campaigns. New campaign sends and schedules, test sends, queued batches and signup emails stop for that newsletter. The common delivery function checks the brake too. Queued messages are retained; batch jobs retry after five minutes while the brake remains. Other newsletters still have their own checks. Purchase and comment notifications use their existing transactional path and also respect a saved brake.

`resume_newsletter_sending` (`POST /api/v1/newsletters/{id}/resume-sending`) checks the rates again and refuses while either is still over a pause level. It clears only the newsletter brake; campaigns are resumed separately. A newer brake revision wins over a concurrent resume. The action is class `send`, so an agent that needs approval cannot resume on its own.

Account-wide, campaign, spam-trap and provider blocks remain in force. A newsletter brake reduces continued sending from a troubled list; it does not give brands separate SES tenants or guarantee separate domain/IP reputation. A severe signal can still block the account.

## Warm-up

Each newsletter earns its own pace from its settled healthy campaigns and queued/recent sends. Its first send starts a 30-day warm-up. The slower of the account's pace and the newsletter's pace is used. Another brand's history cannot prove its volume. Changing the sender domain clears its warm-up date and excludes earlier campaigns from its proof. An admin restarting or ending the account's warm-up does the same for its existing newsletters; later sender-domain changes start over.

SES quotas are separate by AWS region and shared by all domains using the regional AWS account. This build does not read or raise those live quotas. Before launch, verify production access, daily quota and send rate in each region against the combined fleet's planned volume. AWS reference: https://docs.aws.amazon.com/ses/latest/dg/manage-sending-quotas.html

## Recommendations

`add_recommendation` now accepts another newsletter in the same account. Self-recommendation remains refused. The target must meet the normal eligibility rules, including confirmed opt-in and a live website. Creating a recommendation subscribes nobody and sends nothing. A reader selects the newsletter and then confirms with that newsletter; list membership is never copied between brands. Manage recommendations on `/recommending`, or add a sibling recommendation from `/fleet`.

## Migration and release

`0030_brand_fleet.sql` adds indexes for the fleet's health and campaign queries. New fields are optional JSON document fields; no data backfill is needed. Apply it through the normal approved deploy process before releasing app and API Workers. Rollback can leave these indexes and optional fields in place. Older code will ignore a newsletter brake, so stop affected campaigns before rolling back sending code.

Local checks: `tests/brand-fleet.test.mjs`, the existing newsletter, recommendation, account-health and sending suites, REST/MCP parity and Worker parity, lint, the Next.js build and Worker size budgets. All external services in tests are stubs. DNS propagation, certificates, live SES quotas and actual delivery still need production verification after an approved deployment.
