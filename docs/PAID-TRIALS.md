# Paid trial access fees

A trial offer can charge a one-time upfront access fee for 1–90 days, followed by a fixed recurring plan at its normal price. Zero or omitted `trialAmountCents` keeps the existing free trial. The fee is available on the trial offer type; it cannot be combined with a discount, cardless trial, lifetime payment or pay-what-you-want plan.

For a USD newsletter, create an offer through REST, MCP or the dashboard:

```json
{
	"id": "your-newsletter",
	"name": "First fortnight",
	"type": "trial",
	"trialDays": 14,
	"trialAmountCents": 100,
	"trialNoCard": false
}
```

The currency is frozen from the newsletter. Changing it ends old fee/amount offers and hides their launch banner. The dashboard's Trial charge field uses whole currency units; the API uses minor units. The app keeps its one-unit floor for supported two-decimal currencies, with DKK 2.50 and NOK/SEK 3.00 floors. Stripe can require a higher amount after settlement conversion. Invalid saved terms are refused before creating a checkout.

## Checkout and access

The reader sees the fee, trial duration, selected recurring price and renewal interval before checkout. The button names the trial price; it never calls a fee trial free. Fixed controls and the paid-trial disclosure have matching entries in all six reader languages; creator copy stays authored. Native semantic review remains separate.

Checkout uses the existing subscription flow on the creator's own Stripe account: the recurring Price plus one one-time price on the initial invoice. It requires a card, disables coupons/promotion codes for the fee offer and sets no application fee. The recurring subscription starts billing after its trial period and renews until canceled. The same path uses the server owner's own key when self-hosted, without a connected-account header.

A trialing subscription alone does not prove the fee was paid. The webhook reads the subscription's current initial invoice from Stripe and checks its paid status, subscription reference, creation reason, currency and amount paid before creating/upgrading the contact. It supports the old invoice subscription field and the newer parent subscription reference. An unpaid or mismatched invoice leaves access ungranted; a later payment event can synchronize it. Old free trials retain their existing behavior. A trial's stored access end uses `trial_end` when provided, with the existing short paid-access grace unchanged.

No local job charges the renewal. Cancellation and refunds use the existing creator Stripe billing flow. Refunding a payment does not automatically cancel its subscription. Existing offers keep their terms; make a new offer to change the fee, currency or duration. Expiry and trial redemption limits are checked before checkout; trial limits count confirmed readers and are not a reservation of concurrent sessions. An already-open checkout is not revoked by turning an offer off.

`offers.csv` in the private account export includes fee settings. These settings are not collected-revenue evidence. No new table, migration, cookie, binding or subprocessor is needed. This batch also corrects the currency metadata of zero-price referral gifts to the newsletter's currency.

## Provider basis and release checks

Stripe documents [mixed recurring and one-time Checkout items](https://docs.stripe.com/api/checkout/sessions/create#checkout_session_create-line_items), [subscription trial periods](https://docs.stripe.com/payments/checkout/free-trials) and [upfront one-time items during a trial](https://support.stripe.com/questions/how-to-add-one-time-items-to-invoices-and-subscriptions-in-the-dashboard). Its [minimum payment amounts](https://docs.stripe.com/currencies#minimum-and-maximum-charge-amounts) depend on settlement currency. This implementation uses those existing checkout fields. It does not use the newer [Trial Offer API](https://docs.stripe.com/billing/subscriptions/trials), whose Checkout support currently requires invited private-preview access.

Local tests use fake Stripe invoices, sessions and events. They verify request shape, payment gating, event order, currency, disclosures and direct/connected account headers. They do not prove a live charge, actual cancellation or renewal. Before a production release, verify the creator's exact test-mode Checkout, initial invoice, card authentication, trial end, cancellation, renewal and refund behavior through the existing approval-gated release process. No live offers, charges, refunds or subscriptions were created by this build.
