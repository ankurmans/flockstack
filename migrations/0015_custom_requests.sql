CREATE TABLE IF NOT EXISTS c_customrequests (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_customrequests__accountId ON c_customrequests (accountId);
CREATE INDEX IF NOT EXISTS i_customrequests__createdAt_d ON c_customrequests (json_extract(data, '$.createdAt') DESC);
CREATE INDEX IF NOT EXISTS i_customrequests__updatedAt ON c_customrequests (json_extract(data, '$.updatedAt') ASC);
