CREATE TABLE IF NOT EXISTS c_aiusages (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_aiusages__accountId ON c_aiusages (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_aiusages__accountId__day ON c_aiusages (accountId ASC, json_extract(data, '$.day') ASC);
CREATE TABLE IF NOT EXISTS c_campaignversions (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_campaignversions__accountId ON c_campaignversions (accountId);
CREATE INDEX IF NOT EXISTS i_campaignversions__campaignId__createdAt_d ON c_campaignversions (json_extract(data, '$.campaignId') ASC, json_extract(data, '$.createdAt') DESC);
