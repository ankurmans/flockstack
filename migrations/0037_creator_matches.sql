CREATE TABLE IF NOT EXISTS c_creatorconversations (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_creatorconversations__accountId ON c_creatorconversations (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_creatorconversations__accountId__newsletterId__otherNewsletterId ON c_creatorconversations (accountId ASC, json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.otherNewsletterId') ASC);
CREATE INDEX IF NOT EXISTS i_creatorconversations__accountId__newsletterId__lastMessageAt_d___id_d ON c_creatorconversations (accountId ASC, json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.lastMessageAt') DESC, _id DESC);
CREATE TABLE IF NOT EXISTS c_creatormessages (_id TEXT PRIMARY KEY NOT NULL, accountId TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS i_creatormessages__accountId ON c_creatormessages (accountId);
CREATE UNIQUE INDEX IF NOT EXISTS u_creatormessages__accountId__newsletterId__messageKey ON c_creatormessages (accountId ASC, json_extract(data, '$.newsletterId') ASC, json_extract(data, '$.messageKey') ASC);
CREATE INDEX IF NOT EXISTS i_creatormessages__accountId__conversationId___id_d ON c_creatormessages (accountId ASC, json_extract(data, '$.conversationId') ASC, _id DESC);
CREATE INDEX IF NOT EXISTS i_newsletters__creatorMatch_enabled__recommendations_listed__archiveEnabled___id ON c_newsletters (json_extract(data, '$.creatorMatch.enabled') ASC, json_extract(data, '$.recommendations.listed') ASC, json_extract(data, '$.archiveEnabled') ASC, _id ASC);
