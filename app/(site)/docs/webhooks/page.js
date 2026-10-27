import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { API_BASE_PATH } from "@/lib/api/rest";
import { getAppUrl } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/pages";
import { FREE_PLAN, PLANS } from "@/lib/plans";
import { WEBHOOK_EVENTS } from "@/lib/webhook-events";
import { MAX_ATTEMPTS, MAX_DELIVERIES_PER_ENDPOINT } from "@/lib/webhook-rules";

export const metadata = getDocsPageMetadata("/docs/webhooks");

const HEADERS_EXAMPLE = `POST /flockstack-events HTTP/1.1
content-type: application/json
user-agent: FlockStack-Webhooks/1.0 (+https://flockstack.io/docs/webhooks)
webhook-id: msg_6650f1c2e9b1d4a0123456ee
webhook-timestamp: 1760952600
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=`;

const VERIFY_EXAMPLE = `// Node.js 18 or later, no packages needed. Use the raw body: parsing and
// re-serializing the JSON changes it, and the signature stops matching.
import { createHmac, timingSafeEqual } from "node:crypto";

const SECRET = process.env.FLOCKSTACK_WEBHOOK_SECRET; // whsec_...
const TOLERANCE_SECONDS = 5 * 60;

export function verifyFlockStackEvent(rawBody, headers) {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"] ?? "";
  if (!id || !timestamp) return false;
  // Refuse old events, so a captured request can't be replayed later.
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;

  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(\`\${id}.\${timestamp}.\${rawBody}\`).digest();
  // While you rotate the secret, events carry two signatures: one is enough.
  return signatures.split(" ").some((part) => {
    const [version, value] = part.split(",");
    if (version !== "v1" || !value) return false;
    const received = Buffer.from(value, "base64");
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
}

// Express: keep the body as text for this route.
app.post("/flockstack-events", express.text({ type: "application/json" }), (req, res) => {
  if (!verifyFlockStackEvent(req.body, req.headers)) return res.status(401).end();
  const event = JSON.parse(req.body);
  // event.type, event.timestamp, event.data. Use webhook-id to skip repeats.
  res.status(204).end();
});`;

export default function WebhooksPage() {
	const appUrl = getAppUrl();
	const created = WEBHOOK_EVENTS[0];
	const example = JSON.stringify({ type: created.type, timestamp: "2026-10-20T09:30:00.000Z", data: created.example }, null, 2);
	const limits = [FREE_PLAN, ...PLANS].map(({ name, webhookEndpoints }) => `${name} ${webhookEndpoints}`).join(", ");

	return (
		<>
			<HeaderDocs kicker="Guides" title="Webhooks">
				FlockStack can tell your own server, a CRM or an automation app when something happens: someone subscribes or leaves, a campaign
				goes out, an order is paid. Each event is a signed JSON POST to an address you choose, retried until it gets through.
			</HeaderDocs>

			<Section title="Add an endpoint" stagger={1}>
				<p>
					On the{" "}
					<Link href="/webhooks" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Webhooks page
					</Link>
					, or with <Code>create_webhook_endpoint</Code>, give the address, and optionally the events it takes and a newsletter. It gets every
					event when you pick none, new kinds included, and every newsletter&apos;s when you pick none. The answer has the signing secret,
					shown once.
				</p>
				<p className="mt-4">
					The address must be <Code>https://</Code> on the default port, at a public address: not localhost, a private network or a cloud
					metadata address. Redirects aren&apos;t followed, so give the final address. Webhooks are on every plan, with this many endpoints:{" "}
					{limits}. Each Zapier or Make trigger uses one. A self-hosted server has no limit.
				</p>
				<BlockCode
					title="Terminal"
					className="mt-4"
					code={`curl ${appUrl}${API_BASE_PATH}/webhooks \\\n  -H "Authorization: Bearer $FLOCKSTACK_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"url":"https://example.com/flockstack-events","events":["subscriber.created","subscriber.unsubscribed"]}'`}
				/>
			</Section>

			<Section title="Events" stagger={2}>
				<ul className="flex flex-col gap-2">
					{WEBHOOK_EVENTS.map(({ type, description }) => (
						<li key={type}>
							<Code>{type}</Code> {description}
						</li>
					))}
				</ul>
				<p className="mt-4">
					Subscriber lifecycle events carry the subscriber with the same fields, by the same names, as the API&apos;s contacts, except <Code>subscriber.deleted</Code>, which carries IDs only. New issue, comment, incoming-reply and Reply Rules events carry IDs only; read their current state through the scoped API. Publication is separate from email delivery. Contacts added by an
					import send no events, so a large import doesn&apos;t flood your endpoint. <Code>webhook.test</Code> is only sent when you ask for a
					test event.
				</p>
			</Section>

			<Section title="What a delivery looks like" stagger={3}>
				<p>
					A POST with a JSON body: the event&apos;s <Code>type</Code>, when it happened, and its <Code>data</Code>. Answer with any 2xx status
					within 15 seconds; do slow work after answering.
				</p>
				<BlockCode title="Headers" className="mt-4" code={HEADERS_EXAMPLE} />
				<BlockCode title="Body" className="mt-4" code={example} />
			</Section>

			<Section title="Check the signature" stagger={4}>
				<p>
					Events are signed the{" "}
					<a href="https://www.standardwebhooks.com" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Standard Webhooks
					</a>{" "}
					way, so any of its libraries verifies them with your secret. By hand: compute HMAC-SHA256 of{" "}
					<Code>webhook-id.webhook-timestamp.body</Code>, keyed with the base64 after <Code>whsec_</Code>, and compare it with each{" "}
					<Code>v1,</Code> value of <Code>webhook-signature</Code>. Refuse events whose timestamp is more than 5 minutes away.
				</p>
				<BlockCode title="verify.js" className="mt-4" code={VERIFY_EXAMPLE} />
				<p className="mt-4">
					<Code>rotate_webhook_secret</Code> makes a new secret. For 24 hours events carry two signatures, one with each secret, so you can
					change your server without missing any.
				</p>
			</Section>

			<Section title="Retries and failures" stagger={5}>
				<p>
					An answer other than 2xx, a redirect, or no answer in 15 seconds is a failure. FlockStack tries again after 1 minute, 5 minutes, 30
					minutes, 2 hours, 6 hours, 12 hours, then once a day: {MAX_ATTEMPTS} attempts over about 5 days. Every attempt has the same{" "}
					<Code>webhook-id</Code>, so you can tell a repeat from a new event. The payload&apos;s top-level <Code>id</Code> is the same identity, including on retries or manual redelivery. Events can arrive out of order.
				</p>
				<p className="mt-4">
					An endpoint that hasn&apos;t accepted an event through those 5 days is turned off, and the account&apos;s owner gets an email. So is
					one that answers <Code>410 Gone</Code>. Fix it, send a test event, and turn it back on. Events from while it was off aren&apos;t sent
					on their own: resend the ones you need from its log (<Code>resend_webhook_delivery</Code>).
				</p>
				<p className="mt-4">
					Each endpoint&apos;s log keeps its latest {MAX_DELIVERIES_PER_ENDPOINT} deliveries with the body sent, the attempts and the last
					answer (<Code>list_webhook_deliveries</Code>).
				</p>
			</Section>

			<Section title="Zapier and Make" stagger={6}>
				<p>
					The{" "}
					<Link href="/docs/zapier-make" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Zapier and Make apps
					</Link>{" "}
					use these webhooks for their triggers: turning a Zap or a scenario on adds an endpoint, turning it off deletes it.
				</p>
			</Section>
		</>
	);
}

function Section({ title, stagger, children }) {
	return (
		<section style={{ "--stagger": stagger }} className="mt-12 max-w-3xl animate-enter first-of-type:mt-0">
			<h2 className="mb-3 text-xl font-semibold tracking-tight">{title}</h2>
			<div className="text-[15px] leading-7 text-pretty text-foreground/80">{children}</div>
		</section>
	);
}

function Code({ children }) {
	return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[13px] text-foreground">{children}</code>;
}
