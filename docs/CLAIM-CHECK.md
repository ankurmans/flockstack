# Claim check

Status: built, 2026-10-29.

The ready-to-send check (`check_campaign`, the review step's "Ready to send?" card) checks the claims of any issue: one a person wrote in the editor, one an agent made with `create_campaign`, a briefing's draft or an imported post. It is the code half of the Briefings engine's check step (docs/BRIEFINGS-DESIGN.md, The run, 7), made to work without a briefing's records: the issue's own links are its sources.

## What it reports

For each paragraph, list item, heading and table cell of the issue (and the subject and preview text):

1. **Dead links.** Every link, judged by the Briefings fetcher's `checkLink` or by reading the page: gone (404, 410 or another 4xx), unreachable, a name that doesn't resolve, too many redirects, or an address inside a private network (refused by the guard, never asked). A 401, 403, 429, a server error, a slow answer or a robots.txt refusal says nothing about whether a reader can open the link, so it is listed as "couldn't be confirmed" (`unsureLinks`), as the existing link check does (`lib/link-check-rules.js` `judgeStatus`), not as dead.
2. **Figures that aren't on their pages.** A figure in a paragraph or list item is looked for on every page that paragraph links to. It is reported when every one of those pages was read and none has it (`unmatchedFigures`). When a page couldn't be read (a file, a refusal, robots.txt, plain http, the check's limits), the figure is neither found nor missing (`unconfirmedFigures`). Figures in a heading, the subject or the preview text sum up the issue and may be on any page it links to.
3. **Figures with no source.** A paragraph or list item that states a figure and links to nothing (`uncitedClaims`). Headings, the subject and the preview text are never uncited claims.

### Figures

`lib/claim-check-rules.js` `figuresIn` reads a figure with its currency, thousands commas, decimals, percent (`%`, percent, per cent, pct) and scale (thousand, million, billion, trillion, k, m, mn, mm, b, bn, tn), and compares values: $1.7 billion, 1.7bn, $1.7B, 1,700 million and 1,700,000,000 are one figure, and so are 8.0%, 8% and 8 percent. A figure with a scale also matches a more exact one on the page that rounds to it at the precision it was written with (1.7 billion for 1,712,000,000; 1.71bn too). A one-letter scale ("5m") may be minutes or metres, so the bare number counts as well. Figures without a scale are compared exactly.

Left out, as they don't state facts to check: years (1800 to 2199 with no unit), dates with a month name or in numbers (2026-10-29, 10/29/2026), times (10:30, 9 am), ordinals (2nd, 21st), decades (1990s), a list's numbering at the start of a line ("1." or "1)"), labels ("issue 12", "No. 5", "page 40", "step 2", "top 10"), numbers that are part of a word or a version (Q3, A320, COVID-19, v1.2.3), footnote marks ([3]), merge tags, numbers with a leading zero (007), and a bare whole number under 10. Numbers inside addresses (`https://…`, `example.com/2024/…`) and email addresses are dropped before anything is read.

Not handled, and reported as not found: a figure in words ("seven"), a page that writes the figure differently enough (a table in "$ millions" with 1,700 for $1.7 billion), and a source cited by footnote number instead of a link in the same paragraph.

## How it is bounded

- **Per check:** 25 links judged, 12 of them read whole (the ones a paragraph's figures need, in issue order), 60 requests in all (robots.txt and redirects included), and no request starts after 25 seconds (`CLAIM_CHECK`). What wasn't reached is reported as not checked, never as a failure.
- **Per request:** the Briefings engine's fetcher (`lib/briefings/fetch.js` `createFetcher`), so the same guards hold: https for a page read (a plain http link is only judged as a link), every address the name resolves to must be public (DNS over HTTPS in a Worker), again on each redirect hop, robots.txt for its user agent `FlockStack-Briefings/1.0 (+https://flockstack.io/docs/briefings-bot)`, 1 MB and 8 seconds, two requests at a time per host, no cookies and nothing worked around. The page's text is read for its figures only and never kept: the stored result has the issue's own excerpts (120 characters) and the addresses.
- **Per account:** 30 checks started an hour, like the link check.
- **Cache:** the result is kept in `ClaimCheck` for the issue's words (`campaignContentHash`: subject, preview text, format and body), so asking again with the same words reads the kept result for a day and opens nothing; any edit asks again. The hourly cron drops results nobody looked at for a week.
- **Calls:** code only, no model. An issue with figures but no links needs no request at all and is answered at once; one with neither passes at once.

## Never in the way of a send

The check runs in its own job (`check-claims`, `lib/claim-check-run.js`), started by the ready-to-send check like the link check, and the review step asks again every two seconds, for up to 50 seconds. A send never starts it, never waits for it and never fetches anything for it.

**Blocking decision:** findings are warnings by default, like every other warning in the ready-to-send check. A newsletter can turn on `requireClaimCheck` (the "Claim check" switch in its settings, or `update_newsletter`): then `send_campaign` and `schedule_campaign` (and the dashboard's Send) refuse with `send_check_failed` until a finished check on the issue's words as they are found no dead link, no missing figure and no figure without a source, and the ready-to-send check shows the claim check as a blocker while it runs or fails. That is one read of `ClaimCheck` in the send's own checks, only for those newsletters. "Couldn't be confirmed" never blocks: a site that refuses programs isn't the writer's to fix. There is no per-campaign switch and no plan gating.

A scheduled issue is checked when it is scheduled; one edited after that is not checked again when its time comes.

## Parity

- Registry: `check_campaign` answers `claims` (state, required, passed, the lists with their counts) beside its items, and its item `claims`; `checking` names which of the links and the claim check are still running. REST `GET /api/v1/campaigns/{id}/check` and the MCP tool are the same action.
- Dashboard: the review step's card and the approval card show the item (`PanelReady`, which spins the rows still being checked); the newsletter settings have the "Claim check" switch, the same field as `update_newsletter`'s `requireClaimCheck`.
- The existing link check (`check-links`, the first 20 links, `links` item) is unchanged. The claim check judges the links again through the stricter fetcher; when the links item already names the same dead links, the claim check's item says "see Links" instead of listing them twice.

## A model step, left out

A model could judge whether the sentence around a figure says what the cited page says (the Briefings check model, or one TypeSafe claim judgment per paragraph), catch figures in words, and match a table's "$ millions" column. It is left out: it would cost a call per issue on every edit, needs an AI key the account may not have, and its answer is a probability where the code check's is a fact. It would fit as an optional step after the code check, with the account's own key, only on paragraphs whose figures were found.
