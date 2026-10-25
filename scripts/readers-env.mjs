// What the lean readers Worker (workers/readers) needs set, so a new region or a rebuilt Worker gets the secrets it needs and no more:
// secrets belong to one Worker, so flockstack-readers and flockstack-readers-eu each need their own copy.
//   node scripts/readers-env.mjs [--json]        (builds workers/readers/dist first when it is missing)
//
// The bundle shares code with the app (lib/config.js alone reads thirty names), so the names it contains are not the names an endpoint
// uses. Two lists keep the owner's list honest: VARIABLES is what an endpoint really reads, with the groups that read it (tests/readers-
// worker-build.test.mjs drives every endpoint through the built Worker and fails if one reads a name that is not here for its group),
// and NOT_NEEDED is the rest of what the bundle mentions and no endpoint reads (the test fails on a name that is in neither, so a new
// dependency cannot add a variable silently).
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OUT_FILE, buildReadersWorker } from "./build-readers-worker.mjs";

// What the platform and the libraries probe for and the code never needs set.
const IGNORED = /^(NODE_ENV|CI|DEBUG|NODE_V8_COVERAGE|JEST_WORKER_ID|NO_PROXY|HTTP_PROXY|HTTPS_PROXY|LOCALAPPDATA|AWS_LOGIN_CACHE_DIRECTORY|UNDICI_NO_FG|FLOCKSTACK_SQLITE|FLOCKSTACK_SQL_LOG|FLOCKSTACK_DOCDB_TRACE|FLOCKSTACK_PRERENDER|VERCEL_.*|NEXT_PUBLIC_.*|KV_REST_.*|AWS_.*)$/;
// Bindings of the Worker (workers/readers/wrangler.jsonc). The vars FLOCKSTACK_CLOUD and FLOCKSTACK_REGION (and SES_REGION in the EU) are there too.
export const BINDINGS = ["DB", "APP"];
export const WRANGLER_VARS = ["FLOCKSTACK_CLOUD", "FLOCKSTACK_REGION"];
// The Worker's own off switch (`wrangler secret put READERS_DISABLED` with true): not something to set up.
export const SWITCHES = ["READERS_DISABLED"];
export const GROUPS = ["tracking", "unsubscribe", "beacons", "forms"];

// kind: `secret` (wrangler secret put, hidden) or `plain` (not secret; a secret put works as well). required: the endpoints of `groups`
// fail or are wrong without it. Otherwise the endpoint degrades in the way `why` says.
export const VARIABLES = {
	BETTER_AUTH_SECRET: { kind: "secret", required: true, groups: ["tracking", "unsubscribe", "forms"], why: "signs and checks the token in every link of an email already sent (open pixel, click, unsubscribe, confirm): the SAME value as the region's app, or those links stop working (an open is not counted, a click shows the Continue page, an unsubscribe says the link is invalid)" },
	BETTER_AUTH_SECRET_PREVIOUS: { kind: "secret", required: false, groups: ["tracking", "unsubscribe", "forms"], why: "only during a rotation: the value BETTER_AUTH_SECRET had before, comma-separated for several. Links already sent signed with it keep working while it is set; unsubscribe links never expire, so it stays as long as old emails may be opened (docs/AUTH-ROTATION.md)" },
	SUPPRESSION_HASH_KEY: { kind: "secret", required: true, groups: ["forms", "unsubscribe"], why: "hashes addresses for the suppression lists: the same value as the region's app, or a suppressed address stops matching and a signup of one is let through" },
	SUPPRESSION_HASH_KEY_PREVIOUS: { kind: "secret", required: false, groups: ["forms", "unsubscribe"], why: "only during a rotation: the value SUPPRESSION_HASH_KEY had before, so addresses suppressed under it still match (docs/AUTH-ROTATION.md)" },
	APP_URL: { kind: "plain", required: true, groups: ["forms", "unsubscribe"], why: "the region's address (https://flockstack.io, https://eu.flockstack.io): the links a confirmation email carries and the hosts that are the app's own" },
	SHARED_DOMAIN: { kind: "plain", required: true, groups: ["forms"], why: "the shared newsletter domain, to tell a newsletter's host from the app's and to build its links" },
	ARCHIVE_CNAME_TARGET: { kind: "plain", required: false, groups: ["forms"], why: "where customers point their newsletter subdomain; read when a signup checks a newsletter's address" },
	ARCHIVE_TRUSTED_HOSTS: { kind: "plain", required: false, groups: ["forms"], why: "hosts the region answers for itself (newsletter.ankur.works)" },
	SENDING_ENABLED: { kind: "plain", required: true, groups: ["forms"], why: "true when the region may send: without it a signup is saved but its confirmation or welcome email is not sent" },
	EMAIL_PROVIDER: { kind: "plain", required: true, groups: ["forms"], why: "ses: the provider that sends the confirmation email" },
	SES_ACCESS_KEY_ID: { kind: "secret", required: true, groups: ["forms"], why: "the IAM user that sends the confirmation email (the app's and the API Worker's)" },
	SES_SECRET_ACCESS_KEY: { kind: "secret", required: true, groups: ["forms"], why: "the secret of the IAM user above" },
	SES_AWS_ACCOUNT_ID: { kind: "plain", required: true, groups: ["forms"], why: "the AWS account SES sends from (the account's tenant is addressed by it)" },
	SES_REGION: { kind: "plain", required: false, groups: ["forms"], why: "the AWS region of the region's SES; eu-west-1 is set in wrangler.jsonc for the EU, us-east-1 is the default" },
	SES_SNS_TOPIC_ARN: { kind: "plain", required: false, groups: ["forms"], why: "the SNS topic of the region's SES events, used when a signup is the first thing to give an account its SES tenant" },
	SEND_RATE_PER_SECOND: { kind: "plain", required: false, groups: ["forms"], why: "the region's SES send rate; the default applies without it" },
	QSTASH_URL: { kind: "plain", required: false, groups: ["forms"], why: "the region's QStash address, used when SES asks a send to be retried later" },
	QSTASH_TOKEN: { kind: "secret", required: false, groups: ["forms"], why: "queues the retry of a confirmation email that SES could not take at once" },
	UPSTASH_REDIS_REST_URL: { kind: "plain", required: false, groups: ["unsubscribe", "forms"], why: "rate limits for unsubscribe and signups; without Redis they are counted in the database, as the app does without it" },
	UPSTASH_REDIS_REST_TOKEN: { kind: "secret", required: false, groups: ["unsubscribe", "forms"], why: "the token for the Upstash database above" },
	ADMIN_EMAILS: { kind: "plain", required: false, groups: ["forms", "unsubscribe"], why: "the admins who get an alert if something here fails (a flood of signups, a refused queue)" },
	EMAIL_FROM: { kind: "plain", required: false, groups: ["forms", "unsubscribe"], why: "the From address of the alert emails above" },
};

// Names the bundle mentions (through code it shares with the app) that no reader endpoint reads.
export const NOT_NEEDED = {
	AI_DAILY_LIMIT: "the app's writing assistant",
	ALLOWED_EMAILS: "a self-hosted server's sign-in allowlist",
	CLOUDFLARE_API_TOKEN: "custom domains and shared DNS, set up from the dashboard",
	CLOUDFLARE_DNS_DAILY_CAP: "shared DNS, set up from the dashboard",
	CLOUDFLARE_SHARED_ZONE_ID: "shared DNS, set up from the dashboard",
	CLOUDFLARE_SAAS_ZONE_ID: "custom domains, set up from the dashboard",
	CREDENTIALS_ENCRYPTION_KEY: "stored third-party credentials, used by integrations",
	DNS_BROKER_SECRET: "a DNS helper for shared addresses, set up from the dashboard",
	DNS_BROKER_URL: "a DNS helper for shared addresses, set up from the dashboard",
	POLAR_ACCESS_TOKEN: "billing",
	POLAR_SERVER: "billing",
	POSTMASTER_DOMAIN: "Google Postmaster, a cron job of the app",
	POSTSHIBA_API_KEY: "the other email provider; FlockStack Cloud sends with SES",
	POSTSHIBA_API_URL: "the other email provider",
	POSTSHIBA_BULK_CLUSTER_ID: "the other email provider",
	POSTSHIBA_INJECT_URL: "the other email provider",
	POSTSHIBA_TEAM_ID: "the other email provider",
	POSTSHIBA_TRANSACTIONAL_CLUSTER_ID: "the other email provider",
	RESEND_API_KEY: "the app's own platform emails (sign-in codes), sent by the app",
	STRIPE_CONNECT_SECRET_KEY: "creators' payments",
	STRIPE_PAYMENTS_WEBHOOK_SECRET: "creators' payments",
	STRIPE_SECRET_KEY: "billing",
	TELEGRAM_BOT_TOKEN: "admin alerts to Telegram; the alert emails above cover this Worker",
	TELEGRAM_CHAT_ID: "admin alerts to Telegram",
	HTTPS_PROXY: "a library probe",
};

export function listEnvironment(source) {
	// process.env.NAME, and env.NAME where a function takes process.env as its argument (lib/config.js, lib/region.js).
	const names = new Set([...source.matchAll(/(?:process\.env|\benv\d*)\.([A-Z][A-Z0-9_]{2,})/g)].map(([, name]) => name));
	return [...names].filter((name) => !IGNORED.test(name) && !BINDINGS.includes(name) && !WRANGLER_VARS.includes(name) && !SWITCHES.includes(name)).sort();
}

export async function readBundleEnvironment(file = OUT_FILE) {
	if (!existsSync(file)) await buildReadersWorker();
	return listEnvironment(readFileSync(file, "utf8"));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const names = await readBundleEnvironment();
	if (process.argv.includes("--json")) console.log(JSON.stringify({ variables: VARIABLES, notNeeded: NOT_NEEDED, unlisted: names.filter((name) => !VARIABLES[name] && !NOT_NEEDED[name]) }, null, 2));
	else {
		console.log(`Bindings (workers/readers/wrangler.jsonc): ${BINDINGS.join(", ")}. Vars set there: ${WRANGLER_VARS.join(", ")}, and SES_REGION in the EU.\n`);
		console.log("Set with `bash scripts/set-reader-secrets.sh us eu`. Per variable: how it is set, whether the endpoints fail without it, which endpoint groups read it.\n");
		for (const group of GROUPS) {
			console.log(`${group}:`);
			for (const [name, info] of Object.entries(VARIABLES).filter(([, info]) => info.groups.includes(group))) {
				console.log(`  ${name.padEnd(26)} ${info.kind.padEnd(6)} ${info.required ? "needed  " : "optional"} ${info.why}`);
			}
		}
		console.log(`\nThe bundle also mentions ${Object.keys(NOT_NEEDED).length} names no endpoint reads (they are shared code of the app):`);
		console.log(`  ${Object.keys(NOT_NEEDED).join(", ")}`);
		const unlisted = names.filter((name) => !VARIABLES[name] && !NOT_NEEDED[name]);
		if (unlisted.length > 0) console.log(`\nNOT CLASSIFIED in scripts/readers-env.mjs: ${unlisted.join(", ")}`);
	}
}
