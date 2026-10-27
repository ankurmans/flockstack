# Referral reward codes and gifted months

A reward can reveal a shared link/message, assign one exact code from private inventory, or issue a complimentary gift for 1–12 months of an existing paid tier. Existing reward IDs keep their history. A benefit already earned cannot change kind, tier or duration; create a new reward instead. The receipt freezes the earned title, instructions and benefit even if the settings later change or remove it.

## Unique codes

Save a code reward, then add exact codes on Referrals or through `add_referral_codes` (POST `/referrals/codes`). Up to 500 codes per call, 200 characters each. Case is preserved; outer spaces, line breaks and control characters are refused. Codes are unique within the newsletter, including codes already used for other rewards. FlockStack does not create vendor coupons or verify their validity.

The inventory never appears in ordinary settings, activity logs or webhooks. It is private account data included in signed account exports. One code is atomically assigned per earned receipt; a unique constraint handles concurrent attempts. A crash after assignment can recover the same code. Deleting a contact deletes their reward receipt but leaves the code assigned to an opaque receipt ID so it cannot return to stock.

## Gifted paid access

A gift reward creates a zero-price gift tied to the referrer's email. The private referral page exposes its redeem link. No Stripe checkout, charge, coupon or application fee is created. Access begins when redeemed, after existing finite paid access. It does not cancel, discount or delay recurring Stripe charges. Existing lifetime access is preserved. The owner should offer these as access rewards and explain their value to a reader who already pays.

The gift can be redeemed for 12 months after it was created. Per-contact redemption receipts prevent a retry after a failed final write from extending access twice. Concurrent gifts update access with a revision check and add their periods in sequence. Month additions clamp to the last day of the target month. Existing purchase/refund rules continue to apply to purchased gifts.

## Pending rewards and retries

The reward is earned once the confirmation counts, even when codes are exhausted or a gift tier has been removed. The reader page says the newsletter is preparing it. It does not claim that access or a code is ready. Reading never spends inventory or creates gifts. Only active subscribers receive a new code or gift.

Restocking adds inventory only. Use Retry pending rewards or `fulfill_referral_rewards` (POST `/referrals/fulfill`) to retry up to 25 earned receipts. Pass `nextCursor` as `cursor` for another batch. A null cursor ends this pass; unresolved rewards can be retried in a later pass. These retries send no email and change no billing. Initial reward notifications use the existing sending guards and private hub link; raw inventory codes and gift capabilities are not embedded in that email. No background retry schedule is required or implied.

Active subscribers retain their earned private rewards when the program is disabled or a reward removed. Inactive contacts and invalid page tokens cannot see them. Old earned rewards are loaded up to the latest 100 receipts per reader. The dashboard stock view includes removed reward IDs for restocking old pending code benefits.

The ID-only `referral_reward.earned` and `referral_reward.fulfilled` events have matching Zapier and Make definitions. A ready transition emits once after its conditional update. Account exports include private code inventory, benefit receipts, gifts and redemption history. Account deletion purges all of them. No new subprocessor or cookie is used.

## Release

Migration `0035_referral_benefits.sql` creates code stock and assignment indexes plus the gift/receipt uniqueness index. Apply it through the approved regional release workflow before deploying. Local tests use SQLite and stubbed services; no live coupon validity, email receipt or Stripe billing outcome is claimed.
