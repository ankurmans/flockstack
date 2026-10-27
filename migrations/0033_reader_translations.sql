-- Private, source-versioned reader translations; expiry and account cleanup.
CREATE TABLE IF NOT EXISTS c_issuetranslations (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_issuetranslations__accountId ON c_issuetranslations (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_issuetranslations__accountId__campaignId__language__sourceHash ON c_issuetranslations (accountId ASC, json_extract(data, '$.campaignId') ASC, json_extract(data, '$.language') ASC, json_extract(data, '$.sourceHash') ASC);
CREATE INDEX IF NOT EXISTS i_issuetranslations__expiresAt ON c_issuetranslations (json_extract(data, '$.expiresAt') ASC);
