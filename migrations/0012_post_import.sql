CREATE TABLE IF NOT EXISTS c_redirects (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_redirects__accountId ON c_redirects (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_redirects__newsletterId__path ON c_redirects (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.path') ASC);
CREATE INDEX IF NOT EXISTS i_redirects__newsletterId__createdAt_d ON c_redirects (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.createdAt') DESC);
