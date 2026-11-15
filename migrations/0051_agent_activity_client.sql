CREATE INDEX IF NOT EXISTS i_agentactivities__accountId__actorName__createdAt_d ON c_agentactivities (accountId ASC, json_extract(data, '$.actorName') ASC, json_extract(data, '$.createdAt') DESC);
