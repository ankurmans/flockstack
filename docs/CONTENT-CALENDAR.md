# Content calendar

Newsletter issues and the LinkedIn posts around them, planned in one place: copy, visuals, review, planned days and a backlog. It extends the campaigns, the calendar, the media library and the action registry; there is no separate app. Everything the dashboard does is an action, so the REST API and MCP do it too.

## What it is not

Planned days are editorial intent. Moving an item, giving it a day or approving it never sends, schedules or publishes anything, and no planning action touches a campaign's status, audience or schedule. Sending an issue stays with the campaign's own actions (`schedule_campaign`, `send_campaign`, their approvals and the undo window). LinkedIn is manual: FlockStack stores the copy and the visuals, the owner posts them and records the address of the post. Nothing is labelled scheduled or published unless a campaign really is, and the code has no LinkedIn integration.

## Data model

Three collections, defined in `models/` and created by `migrations/0029_content_calendar.sql`.

- `ContentItem` (`c_contentitems`): one issue or post. Fields: `newsletterId`, `channel` (`newsletter` or `linkedin`), `externalId`, `title`, `obstacle`, `takeaway`, `funnelStage` (`TOFU`, `MOFU`, `BOFU`), `pillar`, `hook`, `body`, `cta`, `destinationUrl`, `references` (label, url, kind reference or evidence), `notes` (private), `campaignId`, `assets`, `batchId` and `batchPosition`, the plan (`plannedDate`, `plannedTime`, `timeZone`, `plannedAt`, `slotOrder`), `moves`, `state`, `contentVersion`, `review`, and the manual delivery (`publicationUrl`, `deliveredAt`, `deliveredBy`).
- `EditorialBatch` (`c_editorialbatches`): `name`, `description`, `externalId`, `status` (active or archived), an optional recurring `pattern`, and when a review of the whole batch was last asked for.
- `ContentRevision` (`c_contentrevisions`): the editable content after each change, with the version, the fields that changed and who changed them. The last 50 per item stay.

Every document carries the account (`accountScoped`) and a newsletter, so a key limited to one newsletter reaches only that newsletter's items and batches. Deleting an account purges all three, and the account export has one CSV per newsletter that has items (`content-calendar/<slug>.csv`: copy, plan, state, visuals as media IDs with alt text, references and private notes).

### Campaigns

A newsletter item's `campaignId` is its issue; a LinkedIn item's is the issue it is derived from. The campaign is referenced, never copied: the item shows its subject, status and times as they are now, so renaming, scheduling or sending the campaign shows up on the item and in the calendar at once. An issue belongs to at most one newsletter item (a partial unique index on `accountId` and `campaignId` for `channel: newsletter`). A deleted campaign (status `canceled`) shows as a missing link and blocks approval until another is linked.

### Visuals

`assets` is an ordered list of `{ mediaId, altText, kind }` that points at `Upload` records, so nothing is stored twice and the media library's account scoping applies: an upload that is not in the account is not found. `kind` is `image` or `pdf` (a carousel); other files are refused. A LinkedIn post takes pictures or one PDF, not both. The array order is the position (1 first) the API reports. `url` in the API is the file on the CDN, which is the download address; the dashboard downloads through an authenticated same-origin route.

### Plan and time

`plannedDate` is a `YYYY-MM-DD` day. With a time, `plannedTime` is the wall-clock `HH:mm` in the IANA `timeZone`, and `plannedAt` is the UTC instant, worked out when the plan is set (`zonedTimeToInstant` in `lib/time-zone.js`). The wall clock is the truth, so a 09:00 slot stays 09:00 across a clock change and its instant moves. A time the clock skips on a spring-forward day (02:30 in Paris on 2026-03-29) is stored as the first time that exists (03:30); a time shown twice on a fall-back day is its first occurrence. A planned item stays on the day it was planned for, in its own timezone; campaigns in the calendar are placed on the day they go out in the timezone asked.

No `plannedDate` means the item is in the backlog. `slotOrder` orders the items of one newsletter on one day (explicit, 0-based; the API reports `slot` from 1); `batchPosition` orders a batch. `moves` keeps the last 10 changes of the plan so a move is on record; moving never changes `state`.

### Idempotency

`externalId` is unique per account (batches and items each). `create_content_item` with an `externalId` that exists returns that item with `created: false` and changes nothing; the same holds for `create_editorial_batch`. A newsletter item whose campaign is already linked to an item returns that item. A duplicate in another newsletter is a conflict, so a key never learns another newsletter's items. A race on the unique index is read back as the existing item. `import_content_items` repeats it for up to 25 items; items before a failure stay, and running it again is safe.

## Editorial state

`idea`, `drafting`, `ready_for_review`, `changes_requested`, `approved`, `delivered`. This is the editorial state only. An issue's delivery is its campaign's status, shown beside it (`delivery.mode: campaign`); a LinkedIn post's delivery is `not_posted` until a person records where it went (`delivery.mode: manual`). Neither changes the other.

| Who | May |
| --- | --- |
| Author (dashboard or an agent) | set `idea` or `drafting` with `update_content_item`; ask for review with `request_content_review` (refused while something blocks approval) |
| Owner, dashboard only (`decide_content_review`) | approve an item that is `ready_for_review` and has nothing missing; ask for changes on an item in review or approved |
| Author, after approval | `record_content_publication` moves an approved item to `delivered` (a LinkedIn post needs its LinkedIn address; an issue needs a sent campaign); `published: false` returns it to `approved` |

No key or connected app can approve: `decide_content_review` is a dashboard-only action, like `decide_approval`. Approval is separate from the agent approvals of `lib/approvals.js` (a send waiting for the owner) and does not change them.

### Before approval

`checkReadiness` in `lib/content-rules.js` lists what stops an approval (blockers) and what is only worth a look (warnings). A LinkedIn post needs a title, copy within 3,000 characters, a call to action, a visual and alt text on every picture; a newsletter item needs a linked issue with a subject. Funnel stage, pillar, hook and a planned day are warnings. `get_content_item` returns the list, the dashboard shows it beside the editor, and every line of a list (`list_content_items`, a batch's items, the calendar's backlog) carries `canApprove`, `blockerCount` and `blockers`.

### Edits after approval

What approval is about is the title, hook, body, call to action, destination, visuals and linked issue. Changing any of them on an approved item takes the approval back: `state` becomes `changes_requested`, `review.decision` is cleared and `review.editedAfterApproval` is true (with the time) until it is approved again. Planning fields (obstacle, takeaway, pillar, references, private notes, batch) and the planned day do not: a move keeps the approval and is recorded in `moves`. An issue's words live on the campaign, so approval stores a digest of the campaign's subject, preview text and content, and `get_content_item` reports `editedAfterApproval` when the campaign has changed since; requesting a review again puts such an item back in review. A delivered item stays delivered when edited.

### Two people editing

An edit, a review request and a decision each land only on the content version and state they were read at (`writeItem` in `lib/content-items.js` matches `contentVersion` and `state`). If the item changed in between, the call answers `conflict` and nothing is written, so an approval is never given to words the owner didn't see and an old copy never overwrites a newer one. Moving the plan is the one write that doesn't check.

### Revisions

Every change to the editable content writes a `ContentRevision` holding the whole content after the change (reason `create`, `edit` or `restore`), up to 50 per item. `restore_content_revision` brings one back as a new revision, skipping a visual that left the media library or an issue now linked elsewhere, and says so. Restoring over an approved item's words takes the approval back like any edit.

## Patterns

A batch may hold a pattern: `stages` (the funnel stages in the order they repeat, such as TOFU, MOFU, BOFU, TOFU, TOFU) and a `cadence` (weekdays 1 to 7 or every N days, slots per day, a wall-clock time and a timezone). Nothing is hard-coded, no pattern exists until an account makes one, and it never applies itself. `apply_editorial_pattern` is the only thing that uses it: from a start day, the n-th item without a planned day takes the n-th slot, items whose stage differs from the pattern's are listed in `mismatches`, `matchStages` chooses items by stage instead, and `dryRun` only reports. Five posts are five social posts: the pattern places items of any channel and never touches a campaign.

## Calendar

`get_content_plan` answers a range of up to 100 days: planned items by day and slot, campaigns by the time they really go out, and, with `includeBacklog`, the undated items. Each entry has a `kind`: `planned` (an intent) or the campaign's own `scheduled`, `sending`, `paused` or `sent`. A newsletter item whose issue is a draft is `planned` on its planned day; once the issue is scheduled or sent the entry is the campaign's, at the real time, with the item's title and state. Campaigns no item links appear as they do in `get_content_calendar`, which is unchanged. The dashboard's `/campaigns/calendar` shows the same in a month, a week and an agenda view with filters for channel, funnel stage, pillar, batch and state, the backlog beside it, and a form to move an item to a day, so nothing needs dragging.

## Access

Every action has a scope class in `lib/action-scopes.js`.

| Class | Actions |
| --- | --- |
| read | `get_content_plan`, `list_content_items`, `get_content_item`, `list_content_revisions`, `list_editorial_batches`, `get_editorial_batch` |
| write-draft | `create_content_item`, `import_content_items`, `update_content_item`, `set_content_slot`, `reorder_content_items`, `attach_content_asset`, `set_content_assets`, `link_content_campaign`, `request_content_review`, `record_content_publication`, `restore_content_revision`, `create_editorial_batch`, `update_editorial_batch`, `apply_editorial_pattern`, `request_batch_review` |
| destructive | `delete_content_item`, `delete_editorial_batch` |
| admin (dashboard only) | `decide_content_review` |

A read only key reads the plan; a drafts only key plans, edits and asks for reviews; none of these classes is send, so planning never grants sending. Deleting waits for the owner's approval on a send with approval key. Visuals come from the media library through its own actions (`upload_image`, `upload_file`, `list_media`), whose access is unchanged.

## Limits

20 visuals and 20 references per item, 5,000 items and 200 batches per newsletter, 200 items per batch, 25 items per import, 100 days per calendar range, 1,000 entries per range, 50 revisions per item, 10 moves kept per item.

## Dashboard

`/campaigns/calendar` (month, week and agenda, filters, the backlog, drafts that are not in the plan with an Add to plan button, batches), `/campaigns/calendar/items/<id>` (the editor: copy, notes, references, review, plan, linked issue, visuals with copy and download, publication, revisions) and `/campaigns/calendar/batches/<id>` (review of a whole batch, a pattern form with a preview). Every form runs a registered action, so the dashboard and the API agree; reads go through the same actions. A LinkedIn post drafted for a sent issue (`draft_social_posts`, on the issue's report) can be saved to the plan as a post derived from it. Visuals download through `/campaigns/calendar/items/<id>/download/<position>`, a route that checks the session and sends the file with a download name, because a browser ignores `download` on a link to the CDN's host.

## Not in this release

Webhook events for content changes, automatic LinkedIn publishing (the item and the delivery model say `manual` and leave room for a publisher that reports what it supports), drag and drop, per-account default patterns, ZIP downloads of a post's visuals (each file downloads on its own) and a comment thread on an item.
