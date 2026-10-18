CREATE UNIQUE INDEX IF NOT EXISTS u_accounts__polarCustomerId ON c_accounts (json_extract(data, '$.polarCustomerId') ASC) WHERE json_type(data, '$.polarCustomerId') = 'text';
CREATE INDEX IF NOT EXISTS i_accounts__polarSubscriptionId ON c_accounts (json_extract(data, '$.polarSubscriptionId') ASC) WHERE json_type(data, '$.polarSubscriptionId') = 'text';
