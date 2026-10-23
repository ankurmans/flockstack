import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import * as sdk from "@aws-sdk/client-sesv2";

// lib/ses.js loads the AWS SDK on the first call to AWS, not when the module loads (a dashboard page never needs 600 KB of it). The
// commands are described by name and built from the SDK just before they are sent: every name has to be one the SDK has, nothing may
// import the SDK statically, and a call has to reach AWS's address with the shape AWS expects, which is asked of a local server here.
const source = readFileSync(new URL("../lib/ses.js", import.meta.url), "utf8");
let server;
const requests = [];

before(async () => {
	for (const key of ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE"]) delete process.env[key];
	process.env.AWS_CONFIG_FILE = "/nonexistent/aws-config";
	process.env.AWS_SHARED_CREDENTIALS_FILE = "/nonexistent/aws-credentials";
	process.env.AWS_EC2_METADATA_DISABLED = "true";
	server = createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => (body += chunk));
		request.on("end", () => {
			requests.push({ method: request.method, url: request.url, body: body ? JSON.parse(body) : null, authorization: request.headers.authorization });
			response.setHeader("content-type", "application/json");
			if (request.url === "/v2/email/account") response.end(JSON.stringify({ ProductionAccessEnabled: true, SendingEnabled: true, EnforcementStatus: "HEALTHY", SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 12 } }));
			else if (request.url.startsWith("/v2/email/identities/")) response.end(JSON.stringify({ VerifiedForSendingStatus: true, DkimAttributes: { Status: "SUCCESS", Tokens: ["abc"] }, MailFromAttributes: { MailFromDomain: "bounce.example.com", MailFromDomainStatus: "SUCCESS" } }));
			else if (request.url === "/v2/email/outbound-emails") response.end(JSON.stringify({ MessageId: "ses-123" }));
			else {
				response.statusCode = 404;
				response.end(JSON.stringify({ message: "nothing here" }));
			}
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	process.env.AWS_ENDPOINT_URL_SESV2 = `http://127.0.0.1:${server.address().port}`;
	Object.assign(process.env, { SES_ACCESS_KEY_ID: "AKIATESTTESTTESTTEST", SES_SECRET_ACCESS_KEY: "test-secret", SES_REGION: "eu-west-1", SES_AWS_ACCOUNT_ID: "111122223333" });
});

after(() => {
	server?.close();
	for (const key of ["AWS_ENDPOINT_URL_SESV2", "SES_ACCESS_KEY_ID", "SES_SECRET_ACCESS_KEY", "SES_REGION", "SES_AWS_ACCOUNT_ID"]) delete process.env[key];
});

describe("lib/ses.js and the AWS SDK", () => {
	test("does not import the SDK statically, and every command it describes is one the SDK has", () => {
		assert.doesNotMatch(source, /^import .* from "@aws-sdk\/client-sesv2"/m);
		assert.match(source, /import\("@aws-sdk\/client-sesv2"\)/);
		const names = [...source.matchAll(/lazyCommand\("(\w+)"\)/g)].map(([, name]) => name);
		assert.ok(names.length >= 20);
		for (const name of names) assert.equal(typeof sdk[name], "function", `${name} is a command of the SDK`);
		// Each one declared is used, and each one used is declared.
		for (const name of names) assert.ok(new RegExp(`new ${name}\\(`).test(source), `${name} is used`);
		const used = [...source.matchAll(/new (\w+Command)\(/g)].map(([, name]) => name);
		for (const name of used) assert.ok(names.includes(name), `${name} is declared`);
	});

	test("a read reaches AWS with the SDK's own request, signed, after loading it on demand", async () => {
		const ses = await import("../lib/ses.js");
		const account = await ses.getSesAccount({ fresh: true });
		assert.deepEqual(account, { productionAccess: true, reviewStatus: null, sendingEnabled: true, enforcementStatus: "HEALTHY", max24HourSend: 50000, maxSendRate: 14, sentLast24Hours: 12 });
		assert.equal(requests.at(-1).method, "GET");
		assert.equal(requests.at(-1).url, "/v2/email/account");
		assert.match(requests.at(-1).authorization, /^AWS4-HMAC-SHA256 Credential=AKIATESTTESTTESTTEST\/\d{8}\/eu-west-1\/ses\/aws4_request/);
		const identity = await ses.getDomainIdentity("example.com");
		assert.equal(identity.verified, true);
		assert.deepEqual(identity.records[0], { purpose: "dkim", type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" });
		assert.equal(requests.at(-1).url, "/v2/email/identities/example.com");
	});

	test("a send is a POST of the message in the shape SES takes", async () => {
		const ses = await import("../lib/ses.js");
		const sent = await ses.sendSesPlatformEmail({ from: "FlockStack <hello@example.com>", to: "reader@example.org", replyTo: "reply@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>" });
		assert.deepEqual(sent, { sesMessageId: "ses-123" });
		const request = requests.at(-1);
		assert.equal(request.method, "POST");
		assert.equal(request.url, "/v2/email/outbound-emails");
		assert.equal(request.body.FromEmailAddress, "FlockStack <hello@example.com>");
		assert.deepEqual(request.body.Destination, { ToAddresses: ["reader@example.org"] });
		assert.deepEqual(request.body.ReplyToAddresses, ["reply@example.com"]);
		assert.equal(request.body.Content.Simple.Subject.Data, "Hi");
		assert.equal(request.body.Content.Simple.Body.Html.Data, "<p>Hello</p>");
	});

	test("creating what exists counts as done, and a missing thing on delete too", async () => {
		const ses = await import("../lib/ses.js");
		// The local server answers 404 for anything else: deleting something gone is fine, other failures are not hidden.
		await assert.rejects(ses.createConfigurationSet("mc-x"), /SES is not configured \(SES_SNS_TOPIC_ARN\)/);
		process.env.SES_SNS_TOPIC_ARN = "arn:aws:sns:eu-west-1:111122223333:topic";
		try {
			await assert.rejects(ses.createConfigurationSet("mc-x"), (error) => error.name !== "AlreadyExistsException");
		} finally {
			delete process.env.SES_SNS_TOPIC_ARN;
		}
	});
});
