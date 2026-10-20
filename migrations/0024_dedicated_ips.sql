CREATE TABLE IF NOT EXISTS c_dedicatedips (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_dedicatedips__accountId ON c_dedicatedips (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_dedicatedips__ip ON c_dedicatedips (json_extract(data, '$.ip') ASC);
CREATE INDEX IF NOT EXISTS i_dedicatedips__state__releasedAt__leasedAt ON c_dedicatedips (json_extract(data, '$.state') ASC, json_extract(data, '$.releasedAt') ASC, json_extract(data, '$.leasedAt') ASC);
