# Visuals for issues and briefings: design note

Status: design, 2026-10-28. Goal: issues and briefings that are not a wall of text, in the email, on the web and in social previews,
at no model cost and within the size budgets.

## What exists

- `app/archive/[slug]/og/route.js` renders a 1200×630 PNG share card with `next/og` (satori and resvg, already in the app bundle):
  newsletter name, issue title, preview text, date, host. Issue pages, the archive home and mounted pages already carry `og:image`,
  `twitter:image`, width, height and alt pointing at it.
- It renders on every request (about 1.9 s, about 140 KB for an issue), is not stored, and its URL does not change when the card does.
- The dashboard uses one icon set, lucide (`lucide-react`), at one stroke weight.

## Decisions

1. **Render where the renderer already is.** The app's `next/og` route draws the improved card and the section icons. No new Worker,
   no new dependency, no image model.
2. **Store each render once.** A card's content (template version, newsletter name, accent, logo URL, title, date, publisher line,
   section icon keys) is hashed; the PNG is kept in the `IMAGES` bucket under `cards/<newsletterId>/<hash>.png` and served from
   there on every later request. Tags carry the hash (`og?p=<slug>&v=<hash>`), so a changed card is a new URL and an unchanged one
   is cached for a year (`immutable`). A failed render answers the newsletter's default card (also stored), never an error.
3. **Card template.** The newsletter's accent as the background band, logo (or initial in the accent) and name, issue title, date, a
   publisher line (the newsletter's author or "by <name>" from its settings; Underwritten: "by QuoteSweep Media"), and up to four
   section icons of the issue for briefing issues. One font, no photos.
4. **Section icons as PNGs.** `GET /archive/<slug>/icon/<key>.png` renders a lucide icon at 48×48 (shown at 24×24) in the
   newsletter's accent on a transparent background, stored once per key and colour in `IMAGES` like the cards. Keys are a fixed
   list (below); anything else is 404. Email clients block SVG, so email uses these PNGs; the web page uses the same icons inline.
5. **Email.** Optional header image: the issue's card at 600 px wide with alt text (the issue title), on by default for briefings and
   off by default for other newsletters (a newsletter setting, `headerImage`, and a per-campaign override). Briefing sections show
   their icon (24×24, alt = section title) beside the heading. Images off: headings and text read the same, icons carry alt text,
   nothing depends on an image. No emoji as the only visual. Added weight per email: one card (about 60 KB, fetched by the client,
   not counted in the HTML) and at most nine icons (about 1 KB each); the HTML grows by under 2 KB, well inside Gmail's 102 KB.
6. **Web.** The issue page shows the same section icons inline (lucide, accent colour) beside section headings; an empty list in the
   dashboard shows an icon empty state (one shared component).
7. **Briefings.** A section may carry `icon` (one of the keys below; default by section id or format). A story keeps its source's
   `og:image` URL only as `previewImage` on the run, shown as a link preview on the owner's keep/drop page and the run page, never in
   the issue, never copied or hotlinked into email or the web page.

## Icon keys

`lead` (newspaper), `market-pulse` (activity), `earnings` (bar-chart-3), `roundup` (list), `deal-flow` (handshake), `regulation`
(scale), `people` (users), `launches` (rocket), `coming-up` (calendar), `generic` (file-text). A section without an icon takes the
key of its id when one matches, else `generic`.

## Settings and parity

- Newsletter `headerImage` (boolean) and campaign `headerImage` (true, false or null to follow the newsletter), through
  update_newsletter, create_campaign and update_campaign, with dashboard, REST and MCP parity.
- Briefing section `icon` through create_briefing and update_briefing, shown in the dashboard section editor.
- Additive fields only; no index changes, so no migration.

## Size

The app handler is at 34.61 MB of 34.75 MB and the briefings Worker at 749 KB of 750 KB. Before anything is added, a trim pass
frees room in both, measured; nothing in this note needs a new dependency. The icon route reuses `next/og`; the card change is a
template and a cache in the existing route.

## Tests

Tag output (og and twitter image, width, height, alt, hashed URL) on issue, home and mounted pages; the stored card served on the
second request; fallback to the default card when rendering throws; icon route keys and 404; email rendering with images off (alt
text, no layout break, size under the clipping limit); header image on, off and per campaign; section icon parity; story preview
images never in the issue.
