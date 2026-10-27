CREATE TABLE IF NOT EXISTS c_campaigncollaborations (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_campaigncollaborations__accountId ON c_campaigncollaborations (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_campaigncollaborations__accountId__campaignId ON c_campaigncollaborations (accountId ASC, json_extract(data, '$.campaignId') ASC);
CREATE INDEX IF NOT EXISTS i_campaigncollaborations__checkpointAt ON c_campaigncollaborations (json_extract(data, '$.checkpointAt') ASC);
CREATE TABLE IF NOT EXISTS c_editorthreads (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_editorthreads__accountId ON c_editorthreads (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_editorthreads__accountId__externalId ON c_editorthreads (accountId ASC, json_extract(data, '$.externalId') ASC);
CREATE UNIQUE INDEX IF NOT EXISTS u_editorthreads__accountId__campaignId__slot ON c_editorthreads (accountId ASC, json_extract(data, '$.campaignId') ASC, json_extract(data, '$.slot') ASC) WHERE json_type(data, '$.slot') = 'text';
CREATE INDEX IF NOT EXISTS i_editorthreads__accountId__campaignId__createdAt_d___id_d ON c_editorthreads (accountId ASC, json_extract(data, '$.campaignId') ASC, json_extract(data, '$.createdAt') DESC, _id DESC);
