CREATE TABLE IF NOT EXISTS c_forms (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_forms__accountId ON c_forms (accountId);
CREATE INDEX IF NOT EXISTS i_forms__newsletterId__createdAt_d ON c_forms (json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.createdAt') DESC);
CREATE TABLE IF NOT EXISTS c_formdays (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_formdays__accountId ON c_formdays (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_formdays__formId__day ON c_formdays (json_extract(data, '$.formId') ASC, json_extract(data, '$.day') ASC);
