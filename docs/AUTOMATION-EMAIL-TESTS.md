# Automation email A/B tests

An email step can have two to four variants. Use “Test email variants” in its editor, or send `variants` on an email step through `create_automation` or `update_automation`. The base email stays required and becomes the normal email again when testing is turned off.

Each variant has a stable `id`, a private `name` and a `percent`. Omit every percent to divide evenly, or supply positive shares that total 100. Subject, preview text and body are optional overrides; omitted fields inherit the base email. A different body format needs its own body. The base and all override bodies together have a 500 KB byte limit. Drafts may be incomplete; activation checks every effective variant's subject, content and normal sending requirements.

Assignment uses the step's ID (or optional `variantSeed`), the ordered variant IDs and shares, and the contact. Keep these unchanged to preserve groups. A returning contact with a repeatable trigger takes the same variant while that allocation remains unchanged. Changing the seed, order or shares creates a different reported allocation.

`winnerVariantId` sends only the selected variant. Omit it or set it to null to keep testing. Choosing a winner requires pausing an active automation, just like other step edits. FlockStack does not infer statistical significance or choose a winner automatically. Winner sends are reported separately from test sends.

## Delivery and edits

Creating or editing a draft sends nothing. Activation and the normal automation runner remain the only sending path, with the same agent approvals, account/plan limits, current subscriber status, suppression, sending brake and provider handling.

Each enrollment/step still has one Message record. At delivery, the selected variant is resolved from the saved step, and its ID, label, allocation hash, copy revision and test/winner mode are recorded before sending. A paused edit affects emails that have not been delivered. A provider retry reuses its Message record and records the copy actually sent on the successful attempt; it never reports an old copy hash for newly edited text. Already delivered email stays as it was.

Base-copy edits also change the revision of any variant that inherits the changed field. Copy revisions, allocation changes, labels and test/winner modes have separate observed result groups. Disabling a test sends the base email for later deliveries and preserves the old results.

## Results and export

`get_automation_report` and the step's expanded card show variant counts for sent, delivered, opened, clicked, bounced and complained messages. Opens and clicks are unique per message, with the usual privacy-feature caveat for opens. These are observations, not a significant-winner claim. A report includes at most the 200 groups with the most recent sends and sets `variantGroupsTruncated` when older groups are omitted. Overall step totals still cover all messages, including base emails.

The private account export includes `automations.csv` (trigger and step JSON, including variants) and `automation-tests.csv` (selected variant metadata, delivery status and event dates). Both are account-scoped. README and manifest remain first in the ZIP even when optional root CSVs sort alphabetically before the manifest.

No new provider, cookie or database table is introduced. The existing Message and Automation documents hold the configuration and delivery metadata. Run the normal suite, lint, all Worker/public builds and size budgets before release. Local builds and stubbed delivery tests do not send through production providers.
