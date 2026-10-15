import { handleSesEvent } from "@/lib/ses-events";
import { handleSnsRequest } from "@/lib/sns-webhook";

// Bounces, complaints and deliveries from every account's configuration set.
export async function POST(request) {
	return handleSnsRequest(request, { topicArn: process.env.SES_SNS_TOPIC_ARN, label: "ses-webhook", handle: handleSesEvent });
}
