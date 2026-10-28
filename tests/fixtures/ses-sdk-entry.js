// Bundled by tests/api-worker-ses-sdk.test.mjs with the API Worker's build settings.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export async function sendOne() {
	const client = new SESv2Client({ region: "us-east-2", credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "secret-test" } });
	return client.send(new SendEmailCommand({ FromEmailAddress: "a@example.com", Destination: { ToAddresses: ["b@example.org"] }, Content: { Simple: { Subject: { Data: "s" }, Body: { Text: { Data: "t" } } } } }));
}
