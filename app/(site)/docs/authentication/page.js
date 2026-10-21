import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { MAX_ACTIVE_API_KEYS } from "@/lib/actions/api-keys";
import { SLUG_CHANGES } from "@/lib/newsletters";
import { PRESETS, PRESET_INFO } from "@/lib/action-scopes";
import { ACTIONS } from "@/lib/actions/registry";
import { API_BASE_PATH, REQUESTS_PER_KEY } from "@/lib/api/rest";
import { API_KEY_SCAN_REGEX } from "@/lib/api-key-tokens";
import { getAppUrl, isCloud } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/pages";
import { formatNumber, formatUsdCents, formatWindow } from "@/lib/format";
import { EXTRA_EMAILS, FREE_GUARDS, FREE_PLAN } from "@/lib/plans";
import { getRegionUrls } from "@/lib/region";

export const metadata = getDocsPageMetadata("/docs/authentication");

export default function AuthenticationPage() {
	const appUrl = getAppUrl();
	const regionUrls = getRegionUrls();
	const limited = ACTIONS.filter(({ rateLimit }) => rateLimit);
	const signupsOnly = ACTIONS.filter(({ permission }) => permission === "signups");

	return (
		<>
			<HeaderDocs kicker="Guides" title="Authentication">
				Every request carries an API key as a bearer token. The key decides the account, and its level decides what it can do: read only, drafts only, send with approval,
				full access or signups only. ChatGPT and
				Claude don&apos;t need one: they connect to the{" "}
				<Link href="/docs/mcp#chatgpt" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
					MCP server with OAuth
				</Link>
				.
			</HeaderDocs>

			<Section title="Send the key" stagger={1}>
				<p>
					Create keys on the dashboard&apos;s API keys page. They start with <Code>mc_</Code>, or <Code>mc_eu_</Code> for an account in
					the European Union, and are shown once: FlockStack only keeps their hash, their first characters and when they were last used.
					The REST API and the MCP server take the same header. An account has up to {MAX_ACTIVE_API_KEYS} active keys.
				</p>
				<BlockCode title="Header" className="mt-4" code="Authorization: Bearer mc_…" />
			</Section>

			{isCloud() && (
				<Section title="Regions" stagger={2}>
					<p>
						An account lives in one region, and its keys only work there: <Code>{regionUrls.us}</Code> for the United States,{" "}
						<Code>{regionUrls.eu}</Code> for the European Union. A key from the other region answers <Code>401 unauthorized</Code>. The
						prefix tells them apart: <Code>mc_</Code> and 43 more characters in the United States, <Code>mc_eu_</Code> and 43 in the
						European Union. See{" "}
						<Link href="/docs/regions" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
							where your data is stored
						</Link>
						.
					</p>
				</Section>
			)}

			<Section title="Secret scanning" stagger={2}>
				<p>
					To find FlockStack keys in code, logs or a secret scanner&apos;s custom patterns, match both formats with this regular expression.
				</p>
				<BlockCode title="Regular expression" className="mt-4" code={API_KEY_SCAN_REGEX} />
			</Section>

			<Section title="Levels" stagger={2}>
				<div className="overflow-x-auto rounded-xl shadow-border">
					<table className="w-full text-left text-sm">
						<thead>
							<tr className="border-b border-border/60 text-xs text-muted-foreground">
								<th className="py-2 pl-4 font-normal">Level</th>
								<th className="py-2 pl-4 font-normal">In the API</th>
								<th className="py-2 pr-4 pl-4 font-normal">Can</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-border/60 align-top">
							{PRESETS.map((preset) => (
								<tr key={preset}>
									<td className="py-3 pr-4 pl-4 font-medium whitespace-nowrap">{PRESET_INFO[preset].label}</td>
									<td className="py-3 pr-4 font-mono text-[13px] whitespace-nowrap">{preset}</td>
									<td className="py-3 pr-4 text-muted-foreground">
										{preset === "signups" ? (
											<>
												Only {signupsOnly.map(({ name }) => name).join(", ")} (<Code>POST {API_BASE_PATH}/contacts</Code>), for signup forms. It can go in a
												web page: that endpoint answers browsers, and the key can&apos;t read or send anything.
											</>
										) : (
											PRESET_INFO[preset].description
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
				<p className="mt-4">
					Calling something its level doesn&apos;t allow gets <Code>403 forbidden</Code>, and MCP lists only the tools a key can run. A key can also be
					limited to one newsletter, capped at a number of calls a day (<Code>429 daily_cap_reached</Code> past it) and set to expire (<Code>401 unauthorized</Code>{" "}
					after). Keys made before levels existed are signups only, and keys made as full access stay full. Revoked keys get{" "}
					<Code>401 unauthorized</Code>. A send with approval key&apos;s sends and deletes wait for the owner: see{" "}
					<Link href="/docs/agent-safety" className="text-link underline decoration-link/30 underline-offset-4 hover:decoration-link">
						Agent safety
					</Link>
					.
				</p>
			</Section>

			<Section title="A signup form" stagger={3}>
				<p>With a signups only key, from the browser. Pass the visitor&apos;s IP from a server to limit signups per visitor.</p>
				<BlockCode
					title="JavaScript"
					className="mt-4"
					code={`await fetch("${appUrl}${API_BASE_PATH}/contacts", {
  method: "POST",
  headers: {
    Authorization: "Bearer mc_your_signups_only_key",
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ email: form.email.value, source: "website" }),
});`}
				/>
			</Section>

			<Section title="Rate limits" stagger={4}>
				<p>
					Each key gets {REQUESTS_PER_KEY.limit} requests {formatWindow(REQUESTS_PER_KEY.window)} across REST and MCP. Some actions have
					their own limit, for each key and for the account: its keys, connected apps and dashboard share the account&apos;s, so more keys
					don&apos;t raise it. Over a limit the answer is <Code>429 rate_limited</Code>; wait and retry.
				</p>
				<div className="mt-4 overflow-hidden rounded-xl shadow-border">
					<table className="w-full text-left text-sm">
						<tbody className="divide-y divide-border/60">
							<tr>
								<td className="py-2.5 pl-4 font-mono text-[13px]">add_contact</td>
								<td className="py-2.5 pr-4 text-right text-muted-foreground tabular-nums">600 an hour, 5 per visitor in 10 minutes</td>
							</tr>
							<tr>
								<td className="py-2.5 pl-4 font-mono text-[13px]">update_newsletter</td>
								<td className="py-2.5 pr-4 text-right text-muted-foreground tabular-nums">
									{SLUG_CHANGES.limit} slug changes {formatWindow(SLUG_CHANGES.window)} per account
								</td>
							</tr>
							{limited.map(({ name, rateLimit }) => (
								<tr key={name}>
									<td className="py-2.5 pl-4 font-mono text-[13px]">{name}</td>
									<td className="py-2.5 pr-4 text-right text-muted-foreground tabular-nums">
										{rateLimit.limit} {formatWindow(rateLimit.window)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Section>

			<Section title="Plans" stagger={5}>
				{isCloud() ? (
					<p>
						Every account has a plan, the Free plan until it pays for one (<Code>get_billing</Code> says which), so the API and MCP work
						on it with the Free plan&apos;s limits: {formatNumber(FREE_PLAN.subscribers)} subscribers, {formatNumber(FREE_PLAN.emailsPerMonth)} emails
						a month, {FREE_PLAN.webhookEndpoints} webhook endpoint, {FREE_PLAN.newsletters} newsletter and {FREE_PLAN.automations} automations. Its first{" "}
						{FREE_GUARDS.firstCampaigns.count} campaigns go to {formatNumber(FREE_GUARDS.firstCampaigns.recipients)} people at most, refused
						with <Code>plan_limit_emails</Code> and the numbers. A paid plan that ends puts the account back on Free, with its data kept.
						Signups and confirmation emails keep coming in over the plan&apos;s limits. On a paid plan, sending goes on past the
						plan&apos;s emails as extra emails, at {formatUsdCents(EXTRA_EMAILS.pricePerThousand)} per 1,000, up to the monthly limit the
						owner sets with <Code>set_extra_emails_limit</Code>; <Code>extraEmails</Code> in <Code>get_billing</Code> has the count, the
						limit and the cost so far. Past that limit, or on the Free plan or a plan from FlockStack, campaign sends stop with <Code>plan_limit_emails</Code>, and
						over the subscribers with <Code>plan_limit_subscribers</Code>. Welcome emails count toward the month&apos;s emails like
						issues: once they&apos;re used up, new subscribers get none until the count starts over or the plan grows, and don&apos;t get
						one later. <Code>usage.welcomeEmailsPaused</Code> in <Code>get_billing</Code> and <Code>get_overview</Code> says so.
					</p>
				) : (
					<p>
						This server is self-hosted without billing: no plans and no limits on emails or subscribers. The billing endpoints answer{" "}
						<Code>404 billing_off</Code>.
					</p>
				)}
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
