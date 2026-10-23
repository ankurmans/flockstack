CREATE TABLE IF NOT EXISTS c_oauthClient (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_oauthClient__accountId ON c_oauthClient (accountId);
CREATE INDEX IF NOT EXISTS i_oauthClient__clientId ON c_oauthClient (json_extract(data, '$.clientId') ASC);
CREATE TABLE IF NOT EXISTS c_oauthClientResource (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_oauthClientResource__accountId ON c_oauthClientResource (accountId);
CREATE INDEX IF NOT EXISTS i_oauthClientResource__clientId ON c_oauthClientResource (json_extract(data, '$.clientId') ASC);
