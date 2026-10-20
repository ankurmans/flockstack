CREATE TABLE IF NOT EXISTS c_automationwatches (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_automationwatches__accountId ON c_automationwatches (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_automationwatches__automationId__contactId ON c_automationwatches (json_extract(data, '$.automationId') ASC, json_extract(data, '$.contactId') ASC);
CREATE TABLE IF NOT EXISTS c_segmentmembers (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_segmentmembers__accountId ON c_segmentmembers (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_segmentmembers__segmentId__contactId ON c_segmentmembers (json_extract(data, '$.segmentId') ASC, json_extract(data, '$.contactId') ASC);
CREATE INDEX IF NOT EXISTS i_messages__campaignId__openedAt ON c_messages (json_extract(data, '$.campaignId') ASC, json_extract(data, '$.openedAt') ASC) WHERE json_type(data, '$.openedAt') IS NOT NULL;
