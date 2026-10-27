# Reader billing languages

Reader controls use the publication's chosen language: English, Spanish, French, German, Italian or Portuguese. Missing or unsupported settings fall back to English. Creator tier names, custom field labels/options, gift messages and manual moderation reasons stay as written.

The account page shows the same billing facts in each language: monthly, quarterly, yearly or lifetime membership, gifted or complimentary access, a known access deadline, pledge amount and first-charge notice, referral counts and the next reward. Dates use the publication language and UTC; unknown dates are omitted. Gift and complimentary access keep their actual deadline even if an old billing interval says lifetime.

Pledge checkout disclosures, confirmation, first-charge notices and failed-charge emails use the publication language at the time of the operation. Gift checkout disclosures, buyer receipts and recipient messages do too. This changes fixed copy only; amounts, charges, consent, conversion notices, delivery timing and Stripe API parameters keep their existing behavior.

Known reader validation errors translate fixed system wording and numeric limits. Authored labels/options and moderation reasons remain unchanged. Unrecognized provider messages remain as returned; the app does not guess their meaning. Numeric values outside JavaScript's safe integer range are kept as text.

The phrase catalog checks locale columns and placeholders. Tests cover complete paid-account rendering, interval/access states, missing dates/counts, UTC boundaries, parameterized errors and localized pledge/gift mail across all six languages. These checks do not establish native-language semantic quality; human language review and real provider checkout/email QA remain release work.
