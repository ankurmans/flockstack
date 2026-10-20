CREATE TABLE IF NOT EXISTS c_audiousages (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_audiousages__accountId ON c_audiousages (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_audiousages__accountId__month ON c_audiousages (accountId ASC, json_extract(data, '$.month') ASC);
CREATE TABLE IF NOT EXISTS c_audioversions (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_audioversions__accountId ON c_audioversions (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_audioversions__campaignId ON c_audioversions (json_extract(data, '$.campaignId') ASC);
CREATE INDEX IF NOT EXISTS i_audioversions__newsletterId__file_readyAt_d ON c_audioversions (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.file.readyAt') DESC);
