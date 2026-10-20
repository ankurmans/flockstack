CREATE TABLE IF NOT EXISTS c_feedcaches (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_feedcaches__accountId ON c_feedcaches (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_feedcaches__accountId__key ON c_feedcaches (accountId ASC, json_extract(data, '$.key') ASC);
CREATE INDEX IF NOT EXISTS i_feedcaches__fetchedAt ON c_feedcaches (json_extract(data, '$.fetchedAt') ASC);
