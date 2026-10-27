# Supporter badges in comments

A signed-in reader in a founding/supporter tier can choose Show a supporter badge beside my comments on their account page. It is off by default. The owner, REST keys and MCP apps have no operation to opt a reader in. A reader can turn it off after their membership ends too.

The badge requires the reader's current active status, current paid access and a current tier whose founding flag is enabled. Existing access rules apply, including trials, comps, gifts and the short grace period. It identifies membership in that tier; it is not a payment receipt. It does not depend on the separate public supporters-name list.

Issue pages are cached, so no membership/consent snapshot is added to their HTML or comment DTOs. A separate bounded, uncached server action reads the current newsletter, published issue, published requested comments and opted-in authors. It returns comment IDs only, never subscriber IDs, emails, tier names, amounts or consent timestamps. A draft, paid-only or email-only issue cannot expose badges through this action. An unavailable or removed author has none.

Visible pages refresh badge IDs about once a minute and on focus/visibility changes. A refresh clears old badges first, and a failed request leaves them hidden. No badge result is stored in browser storage or a cookie. Already-open pages can retain a visible badge until that refresh; no immediate withdrawal from another reader's screen is promised.

The private subscriber record stores only the latest choice and its update time. Account exports include comment-badges.csv; contact/account deletion removes that preference. Deleting a contact continues to anonymize their existing comments. Fixed controls have matching entries in six reader languages; semantic translation review remains separate.

Migration 0036_supporter_badges.sql adds a sparse index for exporting consent choices on large lists. The preference itself uses optional fields in Contact.community. No new table, provider or binding is needed. No real readers were changed by the local build.
