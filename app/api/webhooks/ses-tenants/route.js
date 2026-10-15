import { handleSnsRequest } from "@/lib/sns-webhook";
import { handleTenantEvent } from "@/lib/tenant-events";

// SES pausing or flagging a tenant, through an EventBridge rule that targets this route's SNS topic.
export async function POST(request) {
	return handleSnsRequest(request, { topicArn: process.env.SES_TENANT_SNS_TOPIC_ARN, label: "ses-tenants", handle: handleTenantEvent });
}
