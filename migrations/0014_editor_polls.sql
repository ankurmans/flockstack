CREATE TABLE IF NOT EXISTS c_polls (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_polls__accountId ON c_polls (accountId);
CREATE INDEX IF NOT EXISTS i_polls__newsletterId__createdAt_d ON c_polls (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.createdAt') DESC);
CREATE INDEX IF NOT EXISTS i_polls__campaignId ON c_polls (json_extract(data, '$.campaignId') ASC) WHERE json_type(data, '$.campaignId') IS NOT NULL;
CREATE TABLE IF NOT EXISTS c_pollvotes (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_pollvotes__accountId ON c_pollvotes (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_pollvotes__pollId__contactId ON c_pollvotes (json_extract(data, '$.pollId') ASC, json_extract(data, '$.contactId') ASC) WHERE json_type(data, '$.contactId') IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS u_pollvotes__pollId__voterKey ON c_pollvotes (json_extract(data, '$.pollId') ASC, json_extract(data, '$.voterKey') ASC) WHERE json_type(data, '$.voterKey') IS NOT NULL;
CREATE INDEX IF NOT EXISTS i_pollvotes__pollId__option ON c_pollvotes (json_extract(data, '$.pollId') ASC, json_extract(data, '$.option') ASC);
