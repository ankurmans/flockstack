import BlockCode from "@/components/BlockCode";
import HeaderDocs from "@/components/HeaderDocs";
import { getAppUrl, getSharedDomain } from "@/lib/config";
import { getDocsPageMetadata } from "@/lib/docs/pages";
import { MOUNT_CHECK_PATH } from "@/lib/mount-rules";

export const metadata = getDocsPageMetadata("/docs/subfolder");

const SITE = "example.com";
const PREFIX = "/newsletter";
const SLUG = "your-slug";

// The recipes for each shape of upstream: the newsletter's shared host, or its archive under the app's address.
function getShapes(appUrl, sharedDomain) {
	const shared = sharedDomain ? `https://${SLUG}.${sharedDomain}` : `https://${SLUG}.<shared domain>`;
	return {
		shared: { upstream: shared, origin: shared, addPrefix: null },
		app: { upstream: `${appUrl}/archive/${SLUG}`, origin: appUrl, addPrefix: `/archive/${SLUG}` },
	};
}

function traefik({ origin, addPrefix }) {
	const middlewares = ["newsletter-strip", ...(addPrefix ? ["newsletter-prefix"] : []), "newsletter-token"];
	return `# /data/coolify/proxy/dynamic/newsletter.yaml on a Coolify server: Traefik's file provider reads it as it changes.
http:
  routers:
    newsletter:
      rule: Host(\`${SITE}\`) && (Path(\`${PREFIX}\`) || PathPrefix(\`${PREFIX}/\`))
      entryPoints: [https]
      priority: 1000
      tls:
        certResolver: letsencrypt
      middlewares: [${middlewares.join(", ")}]
      service: newsletter-flockstack
  middlewares:
    newsletter-strip:
      stripPrefix:
        prefixes: ["${PREFIX}"]
${addPrefix ? `    newsletter-prefix:
      addPrefix:
        prefix: "${addPrefix}"
` : ""}    newsletter-token:
      headers:
        customRequestHeaders:
          X-FlockStack-Mount: '{{ env "FLOCKSTACK_MOUNT_TOKEN" }}'
  services:
    newsletter-flockstack:
      loadBalancer:
        passHostHeader: false
        servers:
          - url: "${origin}"`;
}

function nginx({ upstream }) {
	const host = upstream.replace(/^https?:\/\//, "").split("/")[0];
	return `location = ${PREFIX} { return 308 ${PREFIX}/$is_args$args; }

location ${PREFIX}/ {
	# The trailing slash replaces ${PREFIX}/ with the upstream's path.
	proxy_pass ${upstream}/;
	proxy_set_header Host ${host};
	proxy_set_header X-Forwarded-Host $host;
	proxy_set_header X-Forwarded-Proto $scheme;
	proxy_ssl_server_name on;
	# One line, proxy_set_header X-FlockStack-Mount "fsm_...";, in a file only root can read.
	include /etc/nginx/secrets/flockstack-mount.conf;
}`;
}

function caddy({ origin, addPrefix }) {
	return `${SITE} {
	redir ${PREFIX} ${PREFIX}/ 308
	handle_path ${PREFIX}/* {
${addPrefix ? `		rewrite * ${addPrefix}{uri}\n` : ""}		reverse_proxy ${origin} {
			header_up Host {upstream_hostport}
			header_up X-Forwarded-Host {host}
			header_up X-FlockStack-Mount {$FLOCKSTACK_MOUNT_TOKEN}
		}
	}
}`;
}

function worker({ upstream }) {
	return `// A route on ${SITE}/newsletter*, with the token as a secret: npx wrangler secret put FLOCKSTACK_MOUNT_TOKEN
const PREFIX = "${PREFIX}";
const UPSTREAM = "${upstream}";

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === PREFIX) return Response.redirect(\`\${url.origin}\${PREFIX}/\${url.search}\`, 308);
		if (!url.pathname.startsWith(\`\${PREFIX}/\`)) return fetch(request);
		const headers = new Headers(request.headers);
		headers.set("X-Forwarded-Host", url.host);
		headers.set("X-FlockStack-Mount", env.FLOCKSTACK_MOUNT_TOKEN);
		const target = \`\${UPSTREAM}\${url.pathname.slice(PREFIX.length)}\${url.search}\`;
		return fetch(target, { method: request.method, headers, body: request.body, redirect: "manual" });
	},
};`;
}

function nextjs({ upstream }) {
	return `// app${PREFIX}/[[...path]]/route.js in a Next.js site (Vercel or any host): Next.js rewrites can't add a request header, so a
// route handler forwards the path with the token. FLOCKSTACK_MOUNT_TOKEN is an environment variable of the site.
const UPSTREAM = "${upstream}";
const PREFIX = "${PREFIX}";
const HOP = ["host", "connection", "content-length", "transfer-encoding", "accept-encoding"];

async function forward(request) {
	const url = new URL(request.url);
	const headers = new Headers(request.headers);
	for (const name of HOP) headers.delete(name);
	headers.set("X-Forwarded-Host", url.host);
	headers.set("X-Forwarded-Proto", "https");
	headers.set("X-FlockStack-Mount", process.env.FLOCKSTACK_MOUNT_TOKEN);
	const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer();
	const answer = await fetch(\`\${UPSTREAM}\${url.pathname.slice(PREFIX.length)}\${url.search}\`, { method: request.method, headers, body, redirect: "manual", cache: "no-store" });
	const out = new Headers(answer.headers);
	out.delete("content-encoding");
	out.delete("content-length");
	return new Response(answer.body, { status: answer.status, headers: out });
}

export const dynamic = "force-dynamic";
export { forward as GET, forward as HEAD, forward as POST, forward as PUT, forward as PATCH, forward as DELETE, forward as OPTIONS };`;
}

export default function SubfolderPage() {
	const appUrl = getAppUrl();
	const sharedDomain = getSharedDomain();
	const shapes = getShapes(appUrl, sharedDomain);
	const own = sharedDomain ? shapes.shared : shapes.app;

	return (
		<>
			<HeaderDocs kicker="Guides" title="Subfolder hosting">
				Serve a newsletter&apos;s website at a path of a site you already run, like <Code>https://{SITE}{PREFIX}</Code>, instead of a
				subdomain. Your site&apos;s reverse proxy forwards that path to FlockStack with a token, and the pages come back with every link
				under the path.
			</HeaderDocs>

			<Section title="How it works" stagger={1}>
				<p>
					A reader opens <Code>https://{SITE}{PREFIX}/p/some-issue</Code>. Your proxy strips <Code>{PREFIX}</Code>, forwards the rest to the
					newsletter&apos;s upstream with an <Code>X-FlockStack-Mount</Code> header carrying the mount&apos;s token, and FlockStack answers as
					if the request had come to the newsletter&apos;s own host. In the HTML it sends back, root-relative addresses (its scripts, styles,
					images, forms and the page counter) get <Code>{PREFIX}</Code> in front, so they come back through your proxy too and never meet
					your site&apos;s own files. Absolute addresses are left as they are.
				</p>
				<p className="mt-4">
					The links in emails don&apos;t move: tracking, unsubscribe, confirmation and the other links stay on FlockStack&apos;s address, so an
					email already sent keeps working if your proxy breaks or you remove the subfolder.
				</p>
			</Section>

			<Section title="Set it up" stagger={2}>
				<ol className="list-decimal space-y-2 pl-5">
					<li>
						In the newsletter&apos;s settings, under <strong>Subfolder on your site</strong>, enter the address and choose <strong>Set up</strong>,
						or call <Code>set_newsletter_mount</Code>. You get the token once: store it in your proxy&apos;s secret store, never in a file you
						commit.
					</li>
					<li>Add the route to your proxy, with one of the recipes below.</li>
					<li>
						Choose <strong>Check</strong>, or call <Code>check_newsletter_mount</Code>. FlockStack asks{" "}
						<Code>
							https://{SITE}
							{PREFIX}
							{MOUNT_CHECK_PATH}
						</Code>{" "}
						through your site and expects its own signed answer back. Once it gets one, the website&apos;s links, canonical addresses, sitemap,
						feed and share cards move to the subfolder.
					</li>
				</ol>
				<p className="mt-4">
					A newsletter has its own archive subdomain or a subfolder, not both. The path has one to three parts; the address is https on the
					default port.
				</p>
				<p className="mt-4">
					To send from your own domain while the website lives in the subfolder, add the sending domain as sending only (the checkbox on
					Domains, or <code>sendingOnly: true</code> with <code>add_domain</code>): a subdomain like newsletter.example.com gets its mail
					records and no website record.
				</p>
			</Section>

			<Section title="Where your proxy forwards" stagger={3}>
				<p>
					The upstream depends on the server. With a shared domain it is the newsletter&apos;s own host, <Code>{shapes.shared.upstream}</Code>;
					without one it is the newsletter&apos;s archive under the app&apos;s address, <Code>{shapes.app.upstream}</Code>. This server uses{" "}
					<Code>{own.upstream}</Code>, and the dashboard shows the exact one for each newsletter. Every recipe below comes in both shapes: the
					second adds <Code>/archive/{SLUG}</Code> after stripping the prefix.
				</p>
				<p className="mt-4">
					Send the original host in <Code>X-Forwarded-Host</Code> (Traefik and Caddy do it by themselves), keep the request&apos;s method,
					body and cookies, and don&apos;t follow redirects for the browser.
				</p>
			</Section>

			<Section title="Traefik (Coolify)" stagger={4}>
				<p>
					A router for the path, <Code>stripPrefix</Code>, a <Code>headers</Code> middleware that adds the token, and a service with{" "}
					<Code>passHostHeader: false</Code> so the upstream gets its own host name. The token is read from the proxy container&apos;s{" "}
					<Code>FLOCKSTACK_MOUNT_TOKEN</Code> environment variable (Traefik&apos;s file provider runs <Code>{`{{ env }}`}</Code> templates);
					on Coolify, set it on the proxy and restart it. The entry point and certificate resolver are the names Coolify uses.
				</p>
				<BlockCode title="With the shared host as the upstream" className="mt-4" code={traefik(shapes.shared)} />
				<BlockCode title="With the app's address as the upstream" className="mt-4" code={traefik(shapes.app)} />
			</Section>

			<Section title="nginx" stagger={5}>
				<BlockCode title="With the shared host as the upstream" code={nginx(shapes.shared)} />
				<BlockCode title="With the app's address as the upstream" className="mt-4" code={nginx(shapes.app)} />
			</Section>

			<Section title="Caddy" stagger={6}>
				<p>
					<Code>handle_path</Code> strips the prefix. The token comes from the <Code>FLOCKSTACK_MOUNT_TOKEN</Code> environment variable.
				</p>
				<BlockCode title="With the shared host as the upstream" className="mt-4" code={caddy(shapes.shared)} />
				<BlockCode title="With the app's address as the upstream" className="mt-4" code={caddy(shapes.app)} />
			</Section>

			<Section title="Next.js (Vercel)" stagger={7}>
				<p>
					For a Next.js site, on Vercel or anywhere: a catch-all route handler under the path, since rewrites can&apos;t add the token header. Set{" "}
					<Code>FLOCKSTACK_MOUNT_TOKEN</Code> in the site&apos;s environment variables.
				</p>
				<BlockCode title="With the shared host as the upstream" className="mt-4" code={nextjs(shapes.shared)} />
				<BlockCode title="With the app's address as the upstream" className="mt-4" code={nextjs(shapes.app)} />
			</Section>

			<Section title="Cloudflare Worker" stagger={7}>
				<p>For a site on Cloudflare: a Worker on a route for the path, with the token as a secret of the Worker.</p>
				<BlockCode title="With the shared host as the upstream" className="mt-4" code={worker(shapes.shared)} />
				<BlockCode title="With the app's address as the upstream" className="mt-4" code={worker(shapes.app)} />
			</Section>

			<Section title="The token" stagger={8}>
				<p>
					A request that carries a token which doesn&apos;t match answers <Code>403</Code>. A new token (<strong>New token</strong>, or{" "}
					<Code>rotate_newsletter_mount_token</Code>) leaves the previous one working for 24 hours, so you can change the proxy&apos;s secret
					without the website going down; the check says when your proxy still sends the previous one. Saving the address again also makes a
					new token, and waits for a new check.
				</p>
			</Section>

			<Section title="What else changes" stagger={9}>
				<ul className="list-disc space-y-2 pl-5">
					<li>
						Once the check passes, a page asked for at the upstream itself without the token is redirected (301) to the same page in the
						subfolder, so search engines see one address. The links in emails, <Code>/api</Code>, <Code>/embed.js</Code>, the files and the
						feeds are never redirected.
					</li>
					<li>
						Readers who sign in get their cookies on your site, host-only and with <Code>Path={PREFIX}</Code>, so the rest of your site never
						receives them. A sign-in link in an email opens on FlockStack&apos;s address and goes on to the same page in the subfolder, where the
						session starts.
					</li>
					<li>
						Your proxy forwards the cookies of your own site under that path too. FlockStack reads only its own, but if your site keeps
						sensitive cookies at <Code>Path=/</Code>, strip them in the proxy.
					</li>
					<li>
						The rewriting runs in FlockStack&apos;s Worker, on FlockStack Cloud and on a self-hosted server deployed with Wrangler alike.{" "}
						<Code>next dev</Code> doesn&apos;t rewrite pages.
					</li>
				</ul>
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
