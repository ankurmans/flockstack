# Audience blocks, HTML snippets and internal links

## Audience blocks

Use `/` → Audience block in the rich editor. Choose free readers, every paid reader, or a minimum paid tier. The block's label reopens its settings; its contents remain editable. Nested blocks apply every enclosing restriction.

Before producing an email, its plain text, a public web body, a table of contents or a translation, FlockStack removes blocks the current reader cannot see. Paid access is checked from the current contact and the newsletter's current tier order. An unavailable minimum tier, invalid guard or unclosed guard fails closed. A tier order change affects minimum-tier blocks; deleting a tier hides them. Test emails show all valid variants. An actual-subscriber preview uses that subscriber's current access.

The public page contains no paid block text. A signed-in reader asks for their variant, including on a page with only a free-reader promotion that a paid reader should not see. Shared RSS, Markdown, agent output and automatically selected pictures use the public variant. Translations use the same block permissions and check them again after inference and before cached output is returned.

Blocks apply to rich issues. The existing top-level paywall break still separates the free and paid remainder; a break inside a box does not act as a top-level break. Minimum-tier issues and issues containing a minimum-tier block do not qualify for metered claims. Metered access never grants a paid tier.

One MP3 cannot enforce several block audiences. Creating audio for an issue with audience blocks is refused, its existing audio is not served or offered in the podcast feed, and the dashboard explains why. Removing the blocks makes a shared audio version possible again. Already delivered emails and previously downloaded files cannot be recalled.

## HTML snippets

Use `/` → HTML snippet to paste up to 20,000 characters of HTML. The editor shows source; previews show the result. Text, tables, links and web pictures use the issue's design. Scripts, forms, frames, styles and unsupported markup are stripped. This is a safe rich-markup block, rather than a whole custom-designed email.

A snippet cannot insert nested editor blocks. Paid audience content and text after a paywall marker pasted inside a snippet are omitted, rather than losing their restriction. Use a normal Audience block or paywall break outside the snippet. Invalid encoding and oversized snippets are omitted. A snippet below a real paywall stays out of the free email, public page and public contents list. Account exports and the audio text planner can read its safe text.

For API clients, the rich markup is `<div data-html="ENCODED_SOURCE"></div>` using `encodeURIComponent` for the source. Visibility markers are `<div data-access="free">…</div>` or `<div data-access="paid" data-min-tier="TIER_ID">…</div>`; omit the minimum for every paid reader.

## Internal links

Type `[[` and a title in the rich editor to choose a sent web issue from the current newsletter. The link keeps its URL and a stable issue reference. It never inserts a draft, email-only issue or another account's content. Manually pasting an ordinary URL creates an ordinary link; the internal link index tracks links inserted with this picker or their equivalent `data-issue-link` anchor.

“Internal issue links” on the editor/report shows up to 100 outgoing references and 50 incoming candidates. `get_issue_links` serves the same owner view over REST and MCP. Each source and target is scoped to the current newsletter, and a reference counts only while its href matches the target's current public path. Changing an archive path does not rewrite previously sent links; an old href stops counting until corrected. No backlinks or private draft titles are exposed on the reader page.

New content saves, published edits and version restores derive `internalLinkIds` from the body. A moved draft clears its old newsletter's index. Historical imports and issues saved before this feature need indexing before incoming links are complete. `index_issue_links` changes metadata only, at most 10 issues per call; pass its returned next ID as after until it returns null. A concurrent edit is skipped; run another pass for skipped records. The dashboard can run the same bounded batches and reports unindexed issues.

No new database table, service or cookie is required for these editor features. The normal tests, builds, public-region render and size budgets apply before release.
