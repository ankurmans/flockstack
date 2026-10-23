CREATE INDEX IF NOT EXISTS i_campaigns__status__hold_sendAfter ON c_campaigns (json_extract(data, '$.status') ASC, json_extract(data, '$.hold.sendAfter') ASC);
