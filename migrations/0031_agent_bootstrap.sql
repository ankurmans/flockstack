CREATE TABLE IF NOT EXISTS c_agentworkspaces (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_agentworkspaces__accountId ON c_agentworkspaces (accountId);
CREATE INDEX IF NOT EXISTS i_agentworkspaces__expiresAt ON c_agentworkspaces (json_extract(data, '$.expiresAt') ASC);
CREATE TABLE IF NOT EXISTS c_bootstrapruns (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_bootstrapruns__accountId ON c_bootstrapruns (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_bootstrapruns__accountId__externalId ON c_bootstrapruns (accountId ASC, json_extract(data, '$.externalId') ASC);
CREATE UNIQUE INDEX IF NOT EXISTS u_campaigns__accountId__externalId ON c_campaigns (accountId ASC, json_extract(data, '$.externalId') ASC) WHERE json_type(data, '$.externalId') = 'text';
CREATE UNIQUE INDEX IF NOT EXISTS u_forms__accountId__externalId ON c_forms (accountId ASC, json_extract(data, '$.externalId') ASC) WHERE json_type(data, '$.externalId') = 'text';
CREATE UNIQUE INDEX IF NOT EXISTS u_newsletters__accountId__externalId ON c_newsletters (accountId ASC, json_extract(data, '$.externalId') ASC) WHERE json_type(data, '$.externalId') = 'text';
