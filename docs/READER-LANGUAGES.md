# Reader languages and issue translation

Choose a publication's interface language in Reader settings: English, Spanish, French, German, Italian or Portuguese. English is the fallback for an unknown language. This applies to built-in subscription and account controls, payment plan controls, gifts, polls, surveys and comments. Token pages inherit the publication's language when a valid link identifies it. Invalid links without a publication use English. Dates and prices use the publication's locale. No language cookie is set.

Author-defined titles, descriptions, tier names, benefits, poll questions, survey questions, field names, personal messages and moderation reasons remain as written. This does not translate the owner's dashboard, legal pages or arbitrary custom emails. The six catalogs have matching keys and interpolation variables; rendering tests exercise checkout, standalone gift controls, poll follow-up and the translation toolbar. This is local functional coverage, not native-speaker editorial review. Some older billing notices and system error messages still use their existing English text.

## Optional issue translation

The owner can enable reader-requested translations in Reader settings when the server has a Workers AI binding. It is off by default. `get_reader_settings` reports `readerTranslations` and `translationsAvailable`; `update_reader_settings` changes the flag through the ordinary registry permissions. No new worker or secret is needed when the existing AI binding is available.

A signed-in, active subscriber can choose a language on an issue and press Translate this issue. The original stays available. The response is a plain-text reading view, without the original styling, interactive embeds or audio. It is escaped by React, never inserted as HTML. Translations can contain mistakes: the toolbar asks the reader to check the original wording. Nothing is sent, scheduled, republished or changed in the original issue.

`POST /api/reader-translation` takes `slug`, `post` and `language`. It requires the publication's reader session. Owner sessions, API keys and OAuth grants do not substitute for that session. The source is a published web issue and only the text that subscriber may read: a free reader gets the teaser of a paid issue and nothing after a paid break; paid-tier restrictions still apply. An email-only issue or draft is unavailable. Access and source text are checked again after inference, including whether the subscriber left or the owner disabled translation.

Only the authored visible text goes to the existing Workers AI models. Contact records, subscriber email fields and session identifiers are not added. Authored content can itself contain personal information. AI Gateway logging and caching are off. Workers AI processes on Cloudflare's global network, so text may leave the publication's storage region; the privacy page, subprocessor list and region documentation disclose this.

A private account-scoped cache uses the issue, target language and hash of the text the reader may see. A paid reader's full-text cache cannot be reused for a free reader's teaser. Entries expire after seven days, are refused at expiry, and are removed by bounded hourly cleanup. A source edit uses a new cache key. Export includes `issue-translations.csv`; deleting an account deletes the cache. Disabling translation immediately refuses even a cached answer.

A cache miss takes one request from the account's existing daily AI allowance. Concurrent requests for the same text share a lease. Failed or incomplete output returns the allowance. A reader can make ten translation requests per hour, including cache hits. Source text over 12,000 characters is refused instead of clipped. The model must return a completion marker and at most 48,000 characters of translated text; incomplete output is refused. These guards do not prove semantic translation accuracy.

## Verification and release

The tests stub all model calls. They cover reader identity, paid/free content separation, raw HTML breaks, revoked access, source edits and setting changes during inference, origin checks, concurrent requests, cache expiry, quota refunds, daily limits and another publication's session. Model quality, live latency and production inference have not been measured.

Migration `0033_reader_translations.sql` creates the private translation cache. Apply it in both regions through the normal approved release workflow before enabling the feature. The app serves this session-bound endpoint; it is not routed to the lean machine API or tracking Worker. Build the app, API, readers and public pages and check the Worker size budgets before release.
