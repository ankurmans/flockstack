# Direct sponsorships

Creators sell placements directly to sponsors through their own Stripe account. FlockStack takes no cut. This is separate from platform billing, paid reader subscriptions and recommendations. There is no sponsor network or ad marketplace.

## Creator workflow

1. Connect payments and enable the newsletter website. Open **Payments → Sponsorships** and turn on new requests.
2. Add a placement type with its description, amount in minor units and supported currency. Open its commercial dates with an explicit IANA time zone. Each date snapshots its price; editing a placement does not rewrite existing quotes.
3. Sponsors choose an open date on `/sponsor` on the newsletter website. Without a newsletter host this is `/archive/<slug>/sponsor`. The footer links there while requests are enabled. A request emails a 24-hour verification link. It neither subscribes the sponsor nor reserves a date.
4. Accept a verified request to reserve its date. Competing requests cannot both reserve the same placement and day. Dates are commercial inventory: they never create, schedule or send a campaign.
5. Create the agreed invoice. FlockStack creates a separate Stripe customer, a one-time `send_invoice` draft and exactly one bound invoice item, then finalizes it with automatic advancement off. It neither charges a saved card nor automatically emails the invoice. **Email current invoice to sponsor** is a separate send action.
6. Review the current creative, destination and optional image. Only the signed-in account owner can approve the exact current creative hash. API keys, OAuth applications and MCP cannot approve. Editing any creative field removes that approval.
7. Once the current owned invoice is paid, open a rich draft issue and use **Insert sponsor** with the booking ID. The editor inserts its immutable snapshot at the current cursor and saves normally. It never replaces the editor document from a stale server copy. A booking belongs to one issue and that issue's resends.
8. Send the issue through the normal review and send workflow. Checks at review, queueing and sending require the current funded booking, exact approved words and destination, its consented public image and its own reserved date. A revoked placement pauses queued sends. A sent page edit cannot insert an unapproved sponsor snapshot.

To change an inserted draft placement, remove its block from the editor, wait for the draft to save, and detach it from the booking page. Scheduled, sending and sent placements cannot be detached. A failed insertion can also be detached when its stored draft has no block.

## Sponsor management and images

After confirming their address, the sponsor receives a private seven-day management capability. It reads only that booking. They can supply creative, upload images, preview their own files, see their invoice and aggregate delivery observations, or withdraw before invoicing starts. Creator actions can email or rotate the management link without returning the capability to an agent. Recovery by booking ID and email gives a generic answer. Opening a verification or management link changes nothing.

Uploads use the existing private `FILES` bucket. PNG, JPEG and WebP are accepted up to 5 MiB, 8192 pixels per side and 32 megapixels, with five uploads per booking. Header and dimension checks are not a full image decoder or malware scan. A stable upload UUID must always contain identical bytes. Failed or unknown R2 puts retain their durable key for retry and account purge.

The uploader explicitly consents to public hosting. The selected image becomes publicly accessible immediately when the human owner approves that creative. Public URLs are signed, omit original filenames and cache for at most five minutes. Approved public images stay available for old emails until account deletion. Unused private uploads can be removed. Private previews require current account access or the sponsor's current capability.

## Invoice recovery and cancellation

Creation uses stable provider idempotency keys, persists each object ID before the next step and recovers a previously attached invoice line by its current identity. Known customer, invoice and item IDs can recover a finalization after an unknown response. An unknown object-creation outcome older than 23 hours requires manual Stripe review; retrying must not create another invoice or release the date.

An unbilled withdrawal releases only its own reservation. After invoicing starts, the creator must review cancellation. An open or uncollectible invoice must be confirmed void before its date is released. An unfinished draft must first be recovered and finalized through **Create or recover agreed invoice**; Stripe voids finalized invoices. An unknown void keeps the date reserved until a retry confirms its current state.

A paid invoice requires explicit acknowledgment that canceling issues **no refund**. The creator handles any owed refund in Stripe. Payment racing with a void keeps the date reserved until a new paid cancellation decision. An attached placement must be detached from its draft first; sent placements retain their delivery history. Refunding money in Stripe and canceling a commercial placement are separate decisions.

Refreshes and verified payment events read the current known invoice from the creator's Stripe account. Stored observations keep money missing from a provider response as `null`. A paid invoice may use customer credit or an out-of-band payment: it is not evidence of net cash or a payout. No payment credentials are stored in FlockStack.

## Delivery reports

Send start freezes the sponsor association on the actual tracked `CampaignLink`. Editing a sent web page cannot rewrite it. Each accepted campaign message records the sponsor IDs in its own rendered email, after audience and paywall filtering. A provider failure or suppression records no accepted sponsor email.

Reports distinguish provider-accepted containing emails, subsequent delivery events, counted link clicks and distinct message clickers. They expose no reader identities or paid issue body to the sponsor. Clickers are messages, not unique people; scanners follow the existing tracking filter. There are no inferred impressions, deliveries from campaign status, or cash totals. Missing click attribution stays unknown. Issue and resend observations are paginated; a page is not a lifetime total.

## Boundaries and operations

- Off by default. Closing requests leaves existing management and invoice access available.
- Up to ten active placement types and ten distinct sponsor blocks per rich issue; the storefront lists up to 100 upcoming open dates. Owner request and date lists paginate.
- Commercial dates are real `YYYY-MM-DD` values within 730 days, plus an explicit IANA zone. They are not scheduled instants.
- The dashboard, REST API and MCP use the same registered actions. Prices, reservation, invoicing, cancellation and financial links require admin scope. Draft keys can prepare approved blocks, upload private images and edit creative; they cannot approve it or handle money. Sponsor emails have send scope.
- Account exports include commercial records, consent and approval facts, invoice observations and original ready images. Unavailable images are listed as missing. Account purge deletes original private/public sponsor objects before deleting their asset records. Existing deletion grace and Stripe's own retention still apply.
- Public controls, disclosure and transactional email copy cover English, Spanish, French, German, Italian and Portuguese. Author-written creative stays as written. Some error messages and provider status names remain English; human language review remains pending.
- Migration `0041_sponsorships.sql` creates the four document tables and their indexes plus the frozen link attribution index. Apply it only through the approved release workflow, in each region. The feature reuses Stripe, transactional sending, D1 and `FILES`; it adds no provider or environment secret.

Local fake-provider tests do not prove live Stripe settlement, SES inbox delivery, R2 behavior, deployed routing or production latency. Those require the separately authorized release and provider checks.
