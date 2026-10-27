# After-signup flows

A saved signup form can have up to three optional steps, one per kind, in any order:

- An open survey from the same newsletter.
- A paid-subscription offer that opens the current plan picker.
- The existing opt-in recommendation form for a newly created active subscriber.

The form's existing HTTPS redirect is the completion destination. Without a redirect, the flow finishes at the newsletter home page, or the hosted form's success screen when its archive is off. Every step has Continue, and a reader can skip the remaining steps. This is optional onboarding; survey answers are not a condition of subscribing.

Configure steps on Forms, or with `flow` in `create_form` and `update_form`. For example:

```json
{
	"flow": [
		{ "type": "survey", "surveyId": "6650f1c2e9b1d4a012345678" },
		{ "type": "upsell" },
		{ "type": "recommendations" }
	],
	"redirectUrl": "https://example.com/thanks",
	"archiveDefault": true
}
```

`archiveDefault: true` uses this form's steps after built-in archive, popup and gated-issue signups too. Each newsletter can select one default form. Replacing it preserves the other forms' own flows. Clearing or deleting an older default cannot clear a newer choice. Deleting the selected form clears its default pointer. Empty steps restore the existing success/redirect behavior and the built-in newsletter-wide survey/recommendations behavior.

Hosted/embedded JSON submissions and plain HTML form posts both open the flow. Embedded forms use their existing validated parent redirect messaging. A pending subscriber still sees the confirmation instruction. A public flow opened without a new subscriber capability never names or opens an existing contact's answers.

Only a contact newly created by that signup receives a one-hour signed flow link. Re-entering an existing address gets a public flow without their subscriber capability. The server checks the link's newsletter, expiry and the current contact status on every page. Invalid, expired, cross-newsletter or inactive-contact capabilities are refused. A flow link is not a reader sign-in, preference token or billing permission. Its steps are optional, so the step number is navigation rather than an authorization boundary. The existing survey/recommendation capability rules apply when those controls are opened.

Surveys use the existing answer action, field mapping and limits. An unavailable or closed survey is skipped with a notice. An upsell appears only when the archive and paid tier are on, payments are ready, and the identified contact is not already paid. It contains a public plan link, with no email prefill and no checkout, subscription or charge on page load. Recommendations need an active identified subscriber; pending readers must confirm first. Nothing is shared with another newsletter until the reader ticks it and submits.

There is no new cookie, flow-session table, background job or analytics. The page is excluded from indexing and referrer headers, available on publication hosts without dashboard login, and excluded from FlockStack's own analytics. Form steps and the selected default pointer stay in the account's regional database and are included in private exports (`forms.csv` and newsletter settings). Existing account purge removes them. No migration or new service binding is needed for the optional document fields.

The built-in reader controls have matching English, Spanish, French, German, Italian and Portuguese phrases; survey titles and creator copy stay as authored. Native-language semantic review remains a separate verification step.
