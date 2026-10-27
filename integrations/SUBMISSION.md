# Connector review preparation

This source is prepared for local review. This build did not log in, register an app, upload a version, promote it, publish it or request a directory review. Provider account/listing state has not been checked. `submission-manifest.json` deliberately keeps `readyToSubmit: false` until the remaining provider checks are done.

## Local checks

From the repository root:

```sh
node --import ./tests/setup/register.mjs --test tests/integrations.test.mjs tests/webhooks.test.mjs tests/reader-events.test.mjs
node --import ./tests/setup/register.mjs scripts/prepare-integrations.mjs
node --import ./tests/setup/register.mjs scripts/prepare-integrations.mjs --check
```

The inventory records versions and SHA-256 hashes of connector source, excluding dependencies and hidden provider configuration. It validates catalog parity and Make component references. It contains no real key, customer data, account email or provider app ID. Regenerate it after editing connector files.

In `integrations/zapier`, with Node.js 22 or later:

```sh
npm ci
npm run validate
npm audit --omit=dev
```

Core and CLI are pinned to 19.2.1. Local validation has zero functional errors, 55 D018 publishing tasks and one D026 custom-domain review warning. D018 requires title-cased provider labels; the repository explicitly requires sentence-case titles/buttons, so this preparation preserves that policy and records the conflict for release review. The form-data dependency is overridden to patched 4.0.6 rather than accepting npm audit's proposed incompatible downgrade of the core. The CLI is a development dependency. Do not use an automatic force upgrade or downgrade. Inspect the full development dependency audit separately before an upload.

## What the apps expose

Zapier has a REST-hook trigger per event plus the hidden newsletter selector, three subscriber/tag actions, subscriber search and find-or-create. Make has the event trigger, connection, dedicated webhook, three actions, search and newsletter selector. Both use the account's own API key and selected US/EU region or self-hosted origin. The key needs webhook-management access; no payment, owner-consent or approval-decision action is exposed by these connectors.

The catalogs follow the app's event order. ID-only event samples are synthetic schemas; unsupported live sample lists return an empty array and never substitute unrelated contacts. Publication events do not claim email delivery. Notifications may arrive repeatedly or out of order; fetch current state and deduplicate using the top-level event ID, which matches the signed webhook-id header. Zapier uses it instead of merging same-millisecond changes. Historical imports, bulk anonymization and account purges do not emit these per-record lifecycle events.

Incoming webhook receivers currently filter event types and use each provider's dedicated URL. FlockStack signs outgoing deliveries, but these connector receivers do not yet verify a raw-body HMAC signature. Treat dedicated URLs as secrets. Confirm provider handling and security requirements with real test workflows before directory review; do not describe receiver signature verification as implemented. API keys are sanitized by Make request logging. Keep credentials, webhook URLs and actual customer payloads out of evidence committed to this repository.

## Reviewer workflow matrix

Use a private, isolated test account and synthetic subscribers. Keep actual credentials in the provider's private reviewer fields.

| Workflow | Required evidence before submission |
| --- | --- |
| Connect and reject a bad key | Correct account region, recognizable connection label and useful authentication error |
| Enable/disable a trigger | Exactly one scoped endpoint on enable; removal on disable, including an already-deleted endpoint |
| Receive an event | Provider execution and correct event/object IDs; only the selected publication/event reaches the workflow |
| Retry and tamper | Retry behavior, deduplication and actual receiver authentication behavior documented |
| Subscriber action/search | Explicit signup consent, fields/tags preserved, absent search returns no fabricated record |
| ID-only events | Held comment, deletion, incoming reply and web-only publication expose IDs, no text/email or paid-access claim |
| US and EU | Each key reaches its own region, never fallback to the other region |
| Make scenarios | Working test scenarios for each visible module, with fresh execution logs |

## Provider review steps

Review the current [Zapier publishing requirements](https://docs.zapier.com/integrations/publish/integration-publishing-requirements) and [version lifecycle](https://docs.zapier.com/platform/manage/version-lifecycle-states). The local schema validator is evidence about source, not production-readiness or directory approval. Provide the owning team's support contact, reviewer account and current API/help links privately. Check for an existing registered app/version before creating one. Registration, upload and promotion are separate release operations requiring approval.

For Make, use its [prerequisites](https://developers.make.com/custom-apps-documentation/app-review/prerequisites) and [review request process](https://developers.make.com/custom-apps-documentation/app-review/request-app-review). The review needs working scenario links, API documentation and owner/support details. Make states that publishing an app cannot be undone through its normal controls and published components cannot be deleted. Finish local/provider testing and obtain explicit approval before that step.

Do not add a homepage directory badge until the actual directory listing has been verified. No directory acceptance, usage, real delivery, revenue or customer outcome is established by these local checks.
