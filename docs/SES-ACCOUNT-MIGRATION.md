# Moving an SES account

Production approval and a quota do not move existing tenants, domains, configuration sets or suppressions.

Before changing sending credentials:

1. Confirm production access, account health, region and quota in the destination. Inventory each region separately.
2. Recreate the active customer tenants, configuration sets and identity associations. Preserve the tenant/configuration-set names the database uses, then prepare a mapping from the old tenant ARNs to the new ARNs. Do not update the live database during preparation.
3. Verify each sender identity using new DKIM CNAMEs alongside the old records. Configure the same regional MAIL FROM after checking its DNS. Keep the existing identities and records for rollback.
4. Create the destination SNS topic and grant SES publish access restricted to the destination account and intended configuration-set ARNs. Recreate event destinations for sends, rejections, rendering failures, delivery, delivery delays, bounces and complaints.
5. Deploy webhook support before subscribing the new topic. Keep `SES_SNS_TOPIC_ARN` pointed at the current publisher during preparation and set `SES_SNS_ADDITIONAL_TOPIC_ARNS` to the new topic ARN. It accepts comma-separated explicit ARNs; signatures are still required. Raw SNS delivery must stay off. Confirm the HTTPS subscription without sending an email.
6. Privately reconcile suppressions from the app and old SES account/tenant. Attribute them using message and customer records, not the recipient's domain. Preserve unsubscribes and the suppression hash key. Do not copy recipient data into this repository.
7. Prepare scoped destination credentials securely. The app and API Worker need consistent settings. Match the rate limiter to the destination quota with headroom; do not change platform sign-in mail or another region incidentally.

The current SES client and customer metadata select one AWS account. Changing the credentials alone does not implement a percentage rollout. Prepare explicit per-customer/message routing and rollback, including any platform mail that uses SES, before the planned staged cutover. Never retry a timed-out send through the other account: the first send may have succeeded.

After an authorized cutover, make the new topic primary and keep the old topic in `SES_SNS_ADDITIONAL_TOPIC_ARNS` while delayed events drain. Only remove old resources and DNS records after the observation period and a separate cleanup decision.
