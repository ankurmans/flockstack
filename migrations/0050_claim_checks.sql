CREATE TABLE IF NOT EXISTS c_claimchecks (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_claimchecks__accountId ON c_claimchecks (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_claimchecks__accountId__campaignId ON c_claimchecks (accountId ASC, json_extract(data, '$.campaignId') ASC);
CREATE INDEX IF NOT EXISTS i_claimchecks__checkedAt ON c_claimchecks (json_extract(data, '$.checkedAt') ASC);
