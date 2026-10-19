CREATE TABLE IF NOT EXISTS c_extraemailusages (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_extraemailusages__accountId ON c_extraemailusages (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_extraemailusages__accountId__periodStart ON c_extraemailusages (accountId ASC, json_extract(data, '$.periodStart') ASC);
CREATE INDEX IF NOT EXISTS i_extraemailusages__due ON c_extraemailusages (json_extract(data, '$.due') ASC) WHERE json_extract(data, '$.due') IS NOT NULL;
