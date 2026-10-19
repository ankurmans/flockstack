CREATE TABLE IF NOT EXISTS c_campaignlinks (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_campaignlinks__accountId ON c_campaignlinks (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_campaignlinks__campaignId__index ON c_campaignlinks (json_extract(data, '$.campaignId') ASC, json_extract(data, '$.index') ASC);
CREATE INDEX IF NOT EXISTS i_messages__campaignId__clickedAt ON c_messages (json_extract(data, '$.campaignId') ASC, json_extract(data, '$.clickedAt') ASC) WHERE json_type(data, '$.clickedAt') IS NOT NULL;
