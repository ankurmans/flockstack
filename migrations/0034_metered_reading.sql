CREATE TABLE IF NOT EXISTS c_meteredreads (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_meteredreads__accountId ON c_meteredreads (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_meteredreads__accountId__newsletterId__contactId__period ON c_meteredreads (accountId ASC, json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.contactId') ASC, json_extract(data, '$.period') ASC);
CREATE INDEX IF NOT EXISTS i_meteredreads__expiresAt ON c_meteredreads (json_extract(data, '$.expiresAt') ASC);
