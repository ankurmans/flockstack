-- Teams, replies and imported paid subscriptions. Existing JSON documents keep their defaults.
CREATE TABLE IF NOT EXISTS c_importedsubscriptions (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_importedsubscriptions__accountId ON c_importedsubscriptions (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_importedsubscriptions__accountId__stripeSubscriptionId ON c_importedsubscriptions (accountId ASC, json_extract(data, '$.stripeSubscriptionId') ASC);
CREATE TABLE IF NOT EXISTS c_replies (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_replies__accountId ON c_replies (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_replies__accountId__externalId ON c_replies (accountId ASC, json_extract(data, '$.externalId') ASC);
CREATE INDEX IF NOT EXISTS i_replies__accountId__newsletterId__createdAt_d ON c_replies (accountId ASC, json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.createdAt') DESC);
CREATE TABLE IF NOT EXISTS c_teamseats (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_teamseats__accountId ON c_teamseats (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_teamseats__accountId__email ON c_teamseats (accountId ASC, json_extract(data, '$.email') ASC);
CREATE INDEX IF NOT EXISTS i_teamseats__userId__status ON c_teamseats (json_extract(data, '$.userId') ASC, json_extract(data, '$.status') ASC);
CREATE INDEX IF NOT EXISTS i_teamseats__email__status ON c_teamseats (json_extract(data, '$.email') ASC, json_extract(data, '$.status') ASC);
