CREATE TABLE IF NOT EXISTS c_giftlinks (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_giftlinks__accountId ON c_giftlinks (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_giftlinks__code ON c_giftlinks (json_extract(data, '$.code') ASC);
CREATE INDEX IF NOT EXISTS i_giftlinks__newsletterId__createdAt_d ON c_giftlinks (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.createdAt') DESC);
CREATE INDEX IF NOT EXISTS i_giftlinks__newsletterId__campaignId__createdAt_d ON c_giftlinks (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.campaignId') ASC, json_extract(data, '$.createdAt') DESC);
CREATE INDEX IF NOT EXISTS i_giftlinks__newsletterId__contactId__createdAt_d ON c_giftlinks (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.contactId') ASC, json_extract(data, '$.createdAt') DESC);
