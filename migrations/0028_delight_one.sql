CREATE INDEX IF NOT EXISTS i_campaigns__status__hold_sendAfter ON c_campaigns (json_extract(data, '$.status') ASC, json_extract(data, '$.hold.sendAfter') ASC);
CREATE TABLE IF NOT EXISTS c_linkchecks (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_linkchecks__accountId ON c_linkchecks (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_linkchecks__accountId__campaignId ON c_linkchecks (accountId ASC, json_extract(data, '$.campaignId') ASC);
CREATE INDEX IF NOT EXISTS i_linkchecks__checkedAt ON c_linkchecks (json_extract(data, '$.checkedAt') ASC);
