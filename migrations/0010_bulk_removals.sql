CREATE TABLE IF NOT EXISTS c_bulkremovals (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_bulkremovals__accountId ON c_bulkremovals (accountId);
CREATE INDEX IF NOT EXISTS i_bulkremovals__accountId__newsletterId__status ON c_bulkremovals (accountId ASC, json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.status') ASC);
