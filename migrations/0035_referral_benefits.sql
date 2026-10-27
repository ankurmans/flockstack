CREATE TABLE IF NOT EXISTS c_referralcodes (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_referralcodes__accountId ON c_referralcodes (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_referralcodes__accountId__newsletterId__codeHash ON c_referralcodes (accountId ASC, json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.codeHash') ASC);
CREATE UNIQUE INDEX IF NOT EXISTS u_referralcodes__accountId__receiptId ON c_referralcodes (accountId ASC, json_extract(data, '$.receiptId') ASC) WHERE json_type(data, '$.receiptId') IS NOT NULL;
CREATE INDEX IF NOT EXISTS i_referralcodes__newsletterId__rewardId__assignedAt___id ON c_referralcodes (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.rewardId') ASC, json_extract(data, '$.assignedAt') ASC, _id ASC);
CREATE UNIQUE INDEX IF NOT EXISTS u_gifts__accountId__referralRewardId ON c_gifts (accountId ASC, json_extract(data, '$.referralRewardId') ASC) WHERE json_type(data, '$.referralRewardId') IS NOT NULL;
