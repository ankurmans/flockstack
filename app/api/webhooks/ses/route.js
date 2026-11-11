import { handleSesEvent } from "@/lib/ses-events";
import { handleSnsRequest } from "@/lib/sns-webhook";

// Bounces, complaints and deliveries from every account's configuration set.
export async function POST(request) {
	const topics = [process.env.SES_SNS_TOPIC_ARN, ...(process.env.SES_SNS_ADDITIONAL_TOPIC_ARNS ?? "").split(",")];
	return handleSnsRequest(request, { topicArn: topics, label: "ses-webhook", handle: handleSesEvent });
}
