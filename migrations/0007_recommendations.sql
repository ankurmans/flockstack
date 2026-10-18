CREATE INDEX IF NOT EXISTS i_newsletters__recommendations_listed ON c_newsletters (json_extract(data, '$.recommendations.listed') ASC);
CREATE TABLE IF NOT EXISTS c_recommendations (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_recommendations__accountId ON c_recommendations (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_recommendations__recommenderId__recommendedId ON c_recommendations (json_extract(data, '$.recommenderId') ASC, json_extract(data, '$.recommendedId') ASC);
CREATE INDEX IF NOT EXISTS i_recommendations__recommendedId__status__createdAt_d ON c_recommendations (json_extract(data, '$.recommendedId') ASC, json_extract(data, '$.status') ASC, json_extract(data, '$.createdAt') DESC);
CREATE INDEX IF NOT EXISTS i_recommendations__recommendedAccountId__status ON c_recommendations (json_extract(data, '$.recommendedAccountId') ASC, json_extract(data, '$.status') ASC);
