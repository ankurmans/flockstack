# Held signups, private website, Mailchimp import, gift links and smaller parity builds

All of these work on FlockStack Cloud and self-hosted servers, and every owner operation is an action in the registry, so the dashboard, the REST API and MCP do the same thing. Nothing here sends a campaign or posts to a social network.

## Hold signups for approval (S18)

`update_newsletter` takes `signupApproval`. With it on, a new signup becomes a contact with the `held` status: after the confirmation email where that is on (confirm first, then wait), straight away where it is not. A held contact is sent nothing, is not an active subscriber for limits or segments of active readers, and cannot sign in to the website. A person you add by hand with the consent box, and a reader who pays, are never held. A signup made through the API with `add_contact` is held like a website signup.

`list_contacts` with `status: held` shows who waits. `approve_held_signups` and `reject_held_signups` take `contactIds` (up to 100) or `all` (oldest first, 100 a call, `remaining` says if there are more). Approving makes the contact active as if they had just confirmed: automations that start on a subscription start, the welcome email goes out if it is on (even where confirmation is on, since the welcome then follows the approval), referral and recommendation credit is given, and webhook endpoints get the new `subscriber.approved` event. Rejecting deletes the contact, sends nothing, and they can ask again. The owner gets one email an hour at most while signups wait, and the Contacts page has an approve-all banner and a menu on each held row.

## Private website (U10)

`update_newsletter` takes `privateArchive`. Every issue page shows the same gate to everyone, with no title or text, and the page asks search engines to stay away. The browser of a signed-in active subscriber asks for the issue and gets it with its title; a held, unsubscribed or signed-out visitor gets nothing. The home page becomes the join form with "This newsletter is private". The issue list, tag and author pages, feed, sitemap, `llms.txt`, Markdown copies and the podcast feed answer 404, `robots.txt` disallows everything and share cards carry no issue title. Audio follows the same rule as reading. Pair it with `signupApproval` to choose who gets in: without approval anyone who signs up can read. Custom pages (About), the shop and the link page stay public. Members reach an issue from its email link or by asking for a sign-in link on the gate.

## Mailchimp archive import (U15)

`create_post_import` and the dashboard accept a Mailchimp ZIP: the campaigns report CSV (it needs the columns Subject Line and Send Time; Title, Campaign ID, Preview Text and From Name are used when there) and each sent campaign's HTML. A file belongs to the row whose Campaign ID, Title or Subject Line equals its file name or the title of its page. Rows with no send time are drafts, rows with no file and files with no row are counted and left out. The template's head, styles, merge tags (`*|FNAME|*` becomes "there"), "view in your browser" line and footer are removed, and layout tables are flattened. There is nothing to redirect from, since Mailchimp's archive pages live on its own address. This follows the exports as Mailchimp documents them; it has not been run against a real account's export.

## Social drafts for Facebook, Threads and Bluesky (G8)

`draft_social_posts` takes any of `linkedin`, `x`, `facebook`, `threads` and `bluesky` in `platforms`; without it, the same LinkedIn and X as before. X, Threads (500) and Bluesky (300, counted in graphemes) are cut to their limits with the issue's link counted. The dialog has a checkbox for each platform. It drafts text only; FlockStack never posts and has no access to any social account.

## Gift links (M4)

A gift link opens one paid issue's page for whoever holds it, with no subscription. Nothing else opens: not the archive, the email, comments, translation or audio. `set_gift_links` turns on links for paid subscribers (off by default) and sets links a subscriber may make a month, browsers a link opens in and days it lasts. A paid reader who can read a paid issue sees "Share this issue" under it. `create_gift_link` makes one yourself for any sent paid issue with a page, `list_gift_links` shows each with its opens and state (`active`, `used_up`, `expired`, `revoked`) and `revoke_gift_link` ends one at once. A browser counts once for a link, kept in a signed cookie, so reading again does not use it up; the open count is a conditional write. Links hold a 22-character random code, are checked against the issue they were made for, and are in the account export (without the codes) and deleted with the account. Migration `0048_gift_links.sql`.

## Paid upgrade offer (M7)

The automation template `paid-upsell` starts when someone subscribes, waits 14 days and, only if they are still on the free plan, sends an email about what paid readers get; a week later, if they are still free, one last note and the tag `upsold`. The owner edits the text and adds the subscribe link before activating. It sends only through the automation engine, so unsubscribed, bounced, suppressed and dormant contacts are skipped like in any automation, and every email carries the unsubscribe link. Emails inside a branch's path now send (they could not be found before).

## Paused and resumed subscriptions (D3)

`subscriber.paused` and `subscriber.resumed` follow the status Stripe reports for the reader's subscription, once per change. A pause also sends `subscriber.downgraded` (the paid issues stopped) before it, and a resume sends `subscriber.upgraded`. Both carry the subscriber, tier, interval and source. They are in the Zapier and Make event lists.

## Schema type and structured data for each issue (X6, X7)

`update_campaign_archive` and `update_published_issue` take `seoSchemaType` (`BlogPosting` by default, `Article` or `NewsArticle`) and `seoJsonLd` (JSON of one block or a list of up to 5, each with an `@type`, checked and stored compact). The page prints the issue's own block first, then the newsletter's `jsonLd`, then the issue's blocks, all escaped so a string cannot end the script tag.

## Device split on the website report (X12)

`get_site_report` has `devices`: views from desktop, mobile and tablet, and `export_report` has a `devices` table. The class is worked out from the browser's name (and the mobile hint it sends) as the page opens, and only the class is counted; the name is not stored. Visits before this build have no device, and an iPad that asks for desktop sites counts as desktop.
