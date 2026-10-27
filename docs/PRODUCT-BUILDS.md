# Authors, editing, previews and subscriber perks

These features run on Cloud and self-hosted servers. Each owner operation uses the same action registry in the dashboard, REST API and MCP. Nothing in this build sends a campaign, changes prices or charges a reader.

## Authors and bulk post tools

Manage guest profiles at `/authors`, or through `list_newsletter_authors`, `upsert_newsletter_author` and `archive_newsletter_author`. A publication can have 50 guest profiles in addition to its default writer. Profiles are public, including their name, biography and photo. Names initially make unique slugs; changing a name retains the slug. Concurrent saves use a revision check. Archiving prevents new assignments and keeps old bylines and public pages.

The issue editor and a completed campaign's report have an author selector. API/MCP clients can set `authorId` on create/update of a draft, or use `set_campaign_author` for a completed issue. Null or `default` uses the publication's writer. A guest must belong to the same publication and be active. Changing a byline leaves sender names and sent emails unchanged. Guest pages list that guest's issues; RSS and structured data use the selected author. An imported author remains as imported unless a profile is explicitly selected.

The campaign selection bar adds Tags and Author. `bulk_update_campaigns` accepts `tag` with `tags` and `tagMode` (`replace`, `add`, `remove`), or `author` with an `authorId` (null for the default writer). Sending/held/paused issues are skipped. Each result includes its reason. Tag updates detect concurrent changes. Moving a draft clears a guest ID from the former publication; duplication keeps an active guest and falls back to the default for an archived one.

## Editing and reader preview

The rich editor's slash menu has Code block and Table of contents alongside its existing button, columns, tables, files, footnotes and paywall break. Code remains escaped text; this adds no remote syntax-highlighting service. Contents links are built from the first 100 visible headings with stable IDs and escaped labels. Headings after a top-level paywall break are absent from a free reader's contents. The contents label uses the publication's reader language.

Preview saved issue on the issue page can render an email or web version for a synthetic free/paid reader or one subscriber by email. `preview_campaign_as_reader` also accepts `contactId`. The subscriber must belong to that issue's publication. Email fields are filled safely; current paid-tier access controls hidden content. Built-in account links use inactive preview anchors, so previewing creates no reader sign-in, unsubscribe or billing capabilities. The iframe is sandboxed. Authored destination links remain as written. A preview reads the saved issue, sends nothing and does not assert that the reader belongs to the campaign's selected segments. Contact-reading access is recorded by the existing agent activity rules.

## Paid subscriber perks

Manage perks at `/perks`, or through `list_subscriber_perks` and `upsert_subscriber_perk`. Up to 50 per publication. A perk has a title, plain-text instructions and optional destination link, code, product file and minimum paid tier. Saves replace the perk's settings: supply its existing ID and the full desired values when editing. Archiving hides the perk and refuses future downloads. No new Stripe object or charge is made.

Readers reach `/perks` on the publication's site from their account page. The shared archive projection never contains private perk settings or codes. The session page checks active paid access and minimum tier. A product reference must be from the same publication and have a private file; the perk uses its current file, so replacing that product file changes what the perk delivers too.

`/api/reader-perks/<publication>/<perk>` checks the current reader session, subscription, tier, perk and product on every request. A copied address alone grants no access. Downloads are attachments with private/no-store headers, no public R2 URL and a per-reader rate limit. Reader opt-out, expiry, a lower tier or archiving takes access away. Existing order download links keep their own rules. Account export includes author/perk settings and the existing product-file export; deleting the account removes both settings and product files.

When an enabled existing welcome email is sent to a newly paid reader, it includes the entitled perk titles and a link to the session-protected page. It includes no perk codes or raw file keys and sends no additional email. It does not override an off welcome or the existing once-per-contact welcome rule. Existing free subscribers upgrading do not get a new welcome solely because perks exist.

## Ranges and webhooks

The overview offers 30, 90, 180, 365 or 730 days, each compared with the same length before it. `get_overview` accepts any integer from 1 to 730. Subscriber history comes from retained join/leave dates, so imports may have incomplete earlier history. The chart does not infer missing events. Hourly sends remain today/yesterday, and usage remains the current billing month. Growth/acquisition reports already support two years, UTM-derived channels/campaigns and CSV export.

New configuration events: `author.created/updated/archived`, `subscriber_perk.created/updated/archived`, `poll.created/updated/deleted`, `survey.created/updated/deleted`, `paid_tier.created/updated/deleted`. The modern paid-tier actions emit these; the legacy single-tier settings action is unchanged. Events contain the resource ID and newsletter ID. `poll.voted` and `survey.responded` contain the response ID plus `parentId` for the poll/survey. They carry no answers, network identifiers or perk codes. An unchanged repeated signed response/vote emits no new response event. Anonymous survey submissions remain separate responses as before.

Existing endpoint newsletter filters, signatures, delivery logs and retries apply. Zapier and Make event definitions match the catalog. This prepares their source packages; it does not publish them in either directory. Triggers without a supported sample-list API return no real samples rather than fetching unrelated subscribers.

These changes add JSON fields to existing newsletter and campaign documents, with no new database table or index. Pending migrations from earlier builds still apply before release. Deployment, live receipt and payment/provider checks remain separate.

## Publication lists and metered reading

See [Mailing lists and metered reading](MAILING-LISTS-AND-METER.md). Optional lists now narrow campaign audiences and have signed reader preferences, delivery-time membership checks and ID-only webhook events. Metered reading is off by default, requires an explicit signed-in reader claim and grants only one published web issue within a UTC month. It does not grant paid status, audio or perks. Both features have export, deletion and privacy coverage; the meter adds migration 0034.

## Editor audiences and internal links

[Audience blocks, HTML snippets and internal links](EDITOR-AUDIENCES-AND-LINKS.md) documents safe HTML source blocks, free/paid/minimum-tier blocks, `[[` issue insertion and the scoped incoming/outgoing view. Reader variants are filtered before email, web and translation output. Shared audio cannot enforce block audiences, so audio is refused for those issues. Existing internal-link references need a bounded indexing pass; no production indexing is performed by the build.

## Automation email tests

[Automation email A/B tests](AUTOMATION-EMAIL-TESTS.md) adds two to four variants within an email step, inherited copy overrides, stable weighted assignment and manual winner mode. Delivery records and reports separate allocations, copy revisions and winner sends; retries preserve the message identity and record the actual delivered copy. Private exports include flow configuration and variant delivery metadata. No automatic significance or winner claim is made.

Referral code inventory and gifted paid-access months: [REFERRAL-REWARDS.md](REFERRAL-REWARDS.md).

Ordered optional signup steps for embedded forms and archive defaults: [SIGNUP-FLOWS.md](SIGNUP-FLOWS.md).

Paid trial access fees and payment verification: [PAID-TRIALS.md](PAID-TRIALS.md).

Reader opt-in supporter badges for comments: [SUPPORTER-BADGES.md](SUPPORTER-BADGES.md).

- Creator matches and private introductions: [guide](CREATOR-MATCHES.md).

- Short web posts and reviewed weekly digest drafts: [guide](SHORT-POSTS.md).

- Observed subscription invoices, calculated MRR and tracked changes: [guide](SUBSCRIPTION-REVENUE.md).

[AI images](AI-IMAGES.md) adds explicit generation in the rich editor, a public media-library image, shared AI quotas, preview before insertion and API/MCP parity.

[Account assistant](ACCOUNT-ASSISTANT.md) adds owner-consented chat through real revocable agent grants, bounded draft/segment/calendar tools and human approvals for sends.


## Reply Rules and reader billing languages

Optional owner-configured AI classification uses public rules and recent consenting manually hidden examples, with a separate reader checkbox and revision check. Existing holds win, uncertain results wait for review, and owners can reverse decisions. Private consent/decision metadata is exported and purged with existing records. See [Reply Rules](REPLY-RULES.md) for exact bounds, provider processing and unverified model scores. All six reader languages now retain complete billing, pledge and referral information and fixed pledge/gift mail wording; authored text stays unchanged. See [reader billing languages](READER-BILLING-LANGUAGES.md). Human native-language and live provider/model QA remain release work.

[Share buttons, custom headers, image crop and GIFs, random cohort sends, and the campaign list tag filter and archive](WRITE-AND-SEND-TOOLS.md).

Held signups, a private website, Mailchimp archive import, gift links, a paid upgrade offer, paused-subscription events, social drafts, per-issue schema and device split: [guide](PARITY-GROW-MONEY-SEO.md).
