CREATE TABLE IF NOT EXISTS c_webhookdeliveries (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_webhookdeliveries__accountId ON c_webhookdeliveries (accountId);
CREATE INDEX IF NOT EXISTS i_webhookdeliveries__endpointId__createdAt_d___id_d ON c_webhookdeliveries (json_extract(data, '$.endpointId') ASC, json_extract(data, '$.createdAt') DESC, _id DESC);
CREATE TABLE IF NOT EXISTS c_webhookendpoints (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_webhookendpoints__accountId ON c_webhookendpoints (accountId);
CREATE INDEX IF NOT EXISTS i_webhookendpoints__accountId__createdAt_d ON c_webhookendpoints (accountId ASC, json_extract(data, '$.createdAt') DESC);
