CREATE UNIQUE INDEX IF NOT EXISTS u_campaigns__newsletterId__importKey ON c_campaigns (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.importKey') ASC) WHERE json_type(data, '$.importKey') = 'text';
CREATE TABLE IF NOT EXISTS c_postimports (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_postimports__accountId ON c_postimports (accountId);
CREATE INDEX IF NOT EXISTS i_postimports__accountId__createdAt_d ON c_postimports (accountId ASC, json_extract(data, '$.createdAt') DESC);
CREATE TABLE IF NOT EXISTS c_redirects (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_redirects__accountId ON c_redirects (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_redirects__newsletterId__path ON c_redirects (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.path') ASC);
CREATE INDEX IF NOT EXISTS i_redirects__newsletterId__createdAt_d ON c_redirects (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.createdAt') DESC);
CREATE INDEX IF NOT EXISTS i_uploads__accountId__sourceUrl ON c_uploads (accountId ASC, json_extract(data, '$.sourceUrl') ASC) WHERE json_type(data, '$.sourceUrl') = 'text';
