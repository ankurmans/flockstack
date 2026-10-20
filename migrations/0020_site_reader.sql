CREATE TABLE IF NOT EXISTS c_sitepages (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_sitepages__accountId ON c_sitepages (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_sitepages__newsletterId__slug ON c_sitepages (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.slug') ASC);
CREATE INDEX IF NOT EXISTS i_sitepages__newsletterId__status__createdAt ON c_sitepages (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.status') ASC, json_extract(data, '$.createdAt') ASC);
