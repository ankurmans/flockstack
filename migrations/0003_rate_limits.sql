CREATE TABLE IF NOT EXISTS c_ratelimits (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_ratelimits__accountId ON c_ratelimits (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_ratelimits__key ON c_ratelimits (json_extract(data, '$.key') ASC);
CREATE INDEX IF NOT EXISTS i_ratelimits__expiresAt ON c_ratelimits (json_extract(data, '$.expiresAt') ASC);
