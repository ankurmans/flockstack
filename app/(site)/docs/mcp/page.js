import Link from "next/link";
import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { ACTION_GROUPS, ACTIONS } from "@/lib/actions/registry";
import { getAppUrl } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/pages";
import { getMcpClients, getMcpConnectors, getMcpUrl } from "@/lib/docs/mcp-clients";
import { getSlug } from "@/lib/docs/reference";
import { MCP_SCOPE } from "@/lib/oauth-rules";
import { cn } from "@/lib/utils";

export const metadata = getDocsPageMetadata("/docs/mcp");

const LINK_CLASS = "font-medium text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground";

export default function McpPage() {
	const appUrl = getAppUrl();
	const mcpUrl = getMcpUrl(appUrl);
	const connectors = getMcpConnectors(appUrl);
	const clients = getMcpClients(appUrl);
	const sendTools = ACTIONS.filter((action) => action.destructive && action.openWorld && action.group === "Campaigns");
	const setups = connectors.length + clients.length;

	return (
		<>
			<HeaderDocs kicker="Guides" title="MCP server" product={{ href: "/newsletter-mcp-server", label: "Running a newsletter from an AI agent" }}>
				ChatGPT, Claude and Grok Bot connect to <code className="font-mono text-[15px] text-foreground">{mcpUrl}</code>: you sign in to
				FlockStack and allow them, no key to copy. Claude Code, Codex and Cursor use an API key, at the level the work needs: start
				with send with approval, so sends wait for you. Each gets one tool per endpoint its level can run, with the same inputs, checks and errors.
			</HeaderDocs>

			<div className="flex max-w-3xl flex-col gap-10">
				<BlockCode title="Connector URL" code={mcpUrl} className="animate-enter" />

				{connectors.map(({ id, name, steps, note }, index) => (
					<section key={id} id={id} style={{ "--stagger": index + 1 }} className="scroll-mt-20 animate-enter">
						<h2 className="mb-3 text-xl font-semibold tracking-tight">{name}</h2>
						<ol className="flex flex-col gap-2.5">
							{steps.map((step, stepIndex) => (
								<li key={step} className="flex gap-3 text-[15px] leading-7 text-pretty text-foreground/80">
									<span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-muted font-mono text-xs text-muted-foreground tabular-nums">
										{stepIndex + 1}
									</span>
									<span>{step}</span>
								</li>
							))}
						</ol>
						{note && <p className="mt-3 text-sm leading-6 text-pretty text-muted-foreground">{note}</p>}
					</section>
				))}

				{clients.map(({ id, name, file, code, note }, index) => (
					<section key={id} id={id} style={{ "--stagger": connectors.length + index + 1 }} className="scroll-mt-20 animate-enter">
						<h2 className="mb-3 text-xl font-semibold tracking-tight">{name}</h2>
						<BlockCode title={file} code={code} />
						<p className="mt-3 text-sm leading-6 text-pretty text-muted-foreground">{note}</p>
					</section>
				))}

				<section style={{ "--stagger": setups + 1 }} className="rounded-2xl bg-red-500/[0.06] p-5 animate-enter sm:p-6">
					<h2 className="font-semibold tracking-tight">Sends can&apos;t be undone</h2>
					<p className="mt-2 text-[15px] leading-7 text-pretty text-foreground/80">
						{sendTools.map(({ name }) => name).join(", ")} are marked destructive, and their descriptions ask the assistant to check with
						you first. Most clients ask before running them. send_test_email sends only to the account owner or to up to 10 addresses you name, never to the list.
					</p>
					<p className="mt-3 text-[15px] leading-7 text-pretty text-foreground/80">
						With a send with approval key or app, or on a newsletter set to ask before an agent sends, those tools don&apos;t send. They answer a result (not an
						error) with <code className="font-mono text-[13px]">status: &quot;approval_required&quot;</code> and a request ID, and nothing happens until you approve it on the{" "}
						<Link href="/approvals" className={LINK_CLASS}>
							Approvals page
						</Link>
						. The assistant reads the outcome with <code className="font-mono text-[13px]">get_approval_status</code>. See{" "}
						<Link href="/docs/agent-safety" className={LINK_CLASS}>
							Agent safety
						</Link>
						.
					</p>
				</section>

				<section id="connected-apps" style={{ "--stagger": setups + 2 }} className="scroll-mt-20 animate-enter">
					<h2 className="text-xl font-semibold tracking-tight">Connected apps</h2>
					<p className="mt-2 text-[15px] leading-7 text-pretty text-foreground/80">
						An app you allow gets the access you pick on the consent page, at the levels of an API key (read only, drafts only, send with approval or
						full access), up to what it asked for, in your account only. The{" "}
						<Link href="/api-keys" className={LINK_CLASS}>
							API keys page
						</Link>{" "}
						lists connected apps with when they were last used. Revoke one there and its tokens stop working right away; it has to ask
						you again to come back.
					</p>
				</section>

				<section style={{ "--stagger": setups + 3 }} className="animate-enter">
					<h2 className="text-xl font-semibold tracking-tight">Tools</h2>
					<p className="mt-2 text-[15px] leading-7 text-pretty text-foreground/80">
						A signups only key sees add_contact alone. Each tool&apos;s inputs and outputs are in the{" "}
						<Link href="/docs/api" className={LINK_CLASS}>
							API reference
						</Link>
						.
					</p>
					<div className="mt-5 flex flex-col gap-6">
						{ACTION_GROUPS.map((group) => (
							<div key={group}>
								<h3 className="mb-2 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">{group}</h3>
								<ul className="divide-y divide-border/60 rounded-xl shadow-border">
									{ACTIONS.filter((action) => action.group === group).map((action) => (
										<li key={action.name} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2.5">
											<Link href={`/docs/api#${getSlug(action)}`} className="font-mono text-[13px] hover:underline">
												{action.name}
											</Link>
											<span className="flex items-center gap-1.5 text-xs">
												<Hint isOn={action.readOnly}>Read-only</Hint>
												<Hint isOn={action.destructive} tone="danger">
													Can&apos;t be undone
												</Hint>
												<Hint isOn={action.idempotent && !action.readOnly}>Safe to repeat</Hint>
											</span>
										</li>
									))}
								</ul>
							</div>
						))}
					</div>
				</section>

				<section style={{ "--stagger": setups + 4 }} className="animate-enter">
					<h2 className="text-xl font-semibold tracking-tight">Protocol</h2>
					<p className="mt-2 text-[15px] leading-7 text-pretty text-foreground/80">
						The server is stateless: no sessions, every request carries a key or a token. It speaks the 2026-07-28 revision and answers
						clients on the 2025 revisions the same way. <code className="font-mono text-[13px]">/api/mcp</code> is the same server, for
						clients that want an /api path.
					</p>
					<p className="mt-3 text-[15px] leading-7 text-pretty text-foreground/80">
						Keys start with <code className="font-mono text-[13px]">mc_</code>, or <code className="font-mono text-[13px]">mc_eu_</code>{" "}
						for an account in the European Union, and only work at their own region&apos;s address.
					</p>
					<p className="mt-3 text-[15px] leading-7 text-pretty text-foreground/80">
						OAuth follows the MCP authorization spec. A request without credentials gets a 401 pointing at{" "}
						<code className="font-mono text-[13px]">/.well-known/oauth-protected-resource/mcp</code>, whose authorization server is{" "}
						<code className="font-mono text-[13px]">{appUrl}</code>. Apps identify themselves with a client metadata document (Grok Bot,
						on Cursor&apos;s agents, registers instead), sign the user in with the authorization code flow and PKCE, and get tokens bound to{" "}
						<code className="font-mono text-[13px]">{mcpUrl}</code>{" "}
						with the <code className="font-mono text-[13px]">{MCP_SCOPE}</code> scope, or a narrower one (<code className="font-mono text-[13px]">flockstack:read</code>,{" "}
						<code className="font-mono text-[13px]">flockstack:drafts</code>, <code className="font-mono text-[13px]">flockstack:send</code> for send with approval). Access tokens last an hour; refresh tokens rotate and
						keep the connection for 90 days after its last use.
					</p>
				</section>
			</div>
		</>
	);
}

function Hint({ isOn, tone, children }) {
	if (!isOn) return null;
	return (
		<span
			className={cn(
				"inline-flex h-5 items-center rounded-full px-2",
				tone === "danger" ? "bg-red-500/10 text-red-700 dark:text-red-400" : "bg-muted text-muted-foreground"
			)}
		>
			{children}
		</span>
	);
}
