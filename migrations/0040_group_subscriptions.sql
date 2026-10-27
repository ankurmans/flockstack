CREATE TABLE IF NOT EXISTS c_groupsubscriptions (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_groupsubscriptions__accountId ON c_groupsubscriptions (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_groupsubscriptions__accountId__externalId ON c_groupsubscriptions (accountId ASC, json_extract(data, '$.externalId') ASC) WHERE json_type(data, '$.externalId') = 'text';
CREATE UNIQUE INDEX IF NOT EXISTS u_groupsubscriptions__accountId__stripeSubscriptionId ON c_groupsubscriptions (accountId ASC, json_extract(data, '$.stripeSubscriptionId') ASC) WHERE json_type(data, '$.stripeSubscriptionId') = 'text';
CREATE INDEX IF NOT EXISTS i_groupsubscriptions__stripeSubscriptionId ON c_groupsubscriptions (json_extract(data, '$.stripeSubscriptionId') ASC) WHERE json_type(data, '$.stripeSubscriptionId') = 'text';
CREATE INDEX IF NOT EXISTS i_groupsubscriptions__accountId__newsletterId__createdAt_d___id_d ON c_groupsubscriptions (accountId ASC, json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.createdAt') DESC, _id DESC);
