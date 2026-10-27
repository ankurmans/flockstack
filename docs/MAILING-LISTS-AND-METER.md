# Mailing lists and metered reading

Mailing lists are optional preferences within a newsletter. They are separate from tags, segments, a reader's free/paid tier and their subscription status. No existing contact is enrolled automatically.

## Mailing lists

Manage up to 50 lists from `/mailing-lists`, `list_mailing_lists` and `upsert_mailing_list`. Each has a reader-visible name and description. Archiving hides new choices and keeps memberships and existing campaign targets. It never changes a campaign into an everyone send.

Readers choose active lists from their signed preference link or account page. Leaving all visible lists preserves archived memberships. Omitted choices from an older preference form leave memberships as they were. General newsletter issues may still arrive: only list-targeted issues use these preferences. The global unsubscribe stops all newsletter emails.

The contact's Tags and fields dialog and `set_contact_lists` let the owner record choices with an explicit consent attestation. This never reactivates a contact, removes a suppression or grants paid access. Existing archived memberships can be kept or removed, but cannot be added to another contact. Owner changes count toward the agent's contact-change approval threshold.

`create_campaign` and `update_campaign` accept `listIds` and `excludeListIds` (10 each). The send step has the same controls. Inclusion matches any chosen list, then exclusions win. Tier, segment, status and suppression rules still apply. Counts, cleanup previews, queueing, resends and send-to-more use the same list filter. Delivery batches check membership again and skip a reader who left the audience after queueing. Duplication and resends keep list targets; moving a draft to another newsletter clears them.

`mailing_list.created`, `mailing_list.updated`, `mailing_list.archived` and `subscriber.lists_changed` contain IDs only. Account exports include list configuration and membership IDs. CSV membership IDs are informational; importing a CSV does not enroll anyone in these lists. No new service, cookie or database table is used for lists.

## Metered reading

`/reader-settings` and `update_reader_settings.meteredReadsPerMonth` set 0–20 free paid web issues per active, signed-in free reader per UTC calendar month. Zero is the default and turns it off.

A reader explicitly selects “Read this issue” before a read is spent. Loading a page, checking the meter, reopening an already claimed issue or requesting a translation cannot spend another read. A unique monthly record and an atomic conditional update enforce the cap even when requests race. Busy writes return a retry message rather than opening content without a grant. No IP or anonymous cookie meter is used.

Only published paid issues with no specific paid-tier restriction or minimum-tier audience block qualify. A claim opens that issue's web body for the current month. It grants no paid subscription, email, audio or perks. Specific tiers, drafts, email-only issues and inactive subscribers stay protected. The same entitlement helper controls the web body, reader translation source and actual-subscriber web preview. Translation checks again after inference; revoking the entitlement cannot return a cached full-body translation.

Turning the setting off revokes existing free access. A positive quota change preserves already claimed issues for that month; it never increases the remaining count beyond the new cap. A new UTC month requires another claim. The original public page, feed, Markdown and agent archive remain teasers.

`MeteredRead` keeps account, newsletter, contact, UTC month, count and at most 20 issue IDs. The hourly cleanup removes it seven days after the month ends. It is included in the private account export and deleted with the contact or account. Migration `0034_metered_reading.sql` creates its table and unique/expiry indexes. The local tests create their own SQLite schema; no production migration is performed by building.

## Verification and rollout

These are local source changes. Test list scoping and consent, archived audiences, leaving all lists, queued-send revocation, concurrent meter claims, UTC boundaries, current tier/session checks, translation revocation, private exports and deletion. The normal full suite, lint, app/API/readers/public builds and size budgets still apply before release. Migration, deployment and real provider delivery remain separate owner-authorized steps.
