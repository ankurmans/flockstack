import "server-only";
import { scoped } from "@/lib/account-scope";
import { actionError } from "@/lib/actions/errors";
import { createDnsRecord, isCloudflareConfigured, listDnsRecords } from "@/lib/cloudflare-api";
import { getArchiveCnameTarget } from "@/lib/config";
import { getDomainSetup } from "@/lib/domain-records";
import { addDomain, checkDomain } from "@/lib/domains";
import { getDmarcStatus } from "@/lib/dmarc-rules";
import { getEmailProvider } from "@/lib/email-provider";
import { getArchiveHostProblem, getDomainProblem, normalizeDomainInput, normalizeHostInput } from "@/lib/sender-rules";
import Domain from "@/models/Domain";

// A platform token can reach many zones. Only the operator can bind a zone to an account; API callers never choose a zone ID.
export function getBrandZones(account, env = process.env) {
	let zones;
	try { zones = JSON.parse(env.CLOUDFLARE_FLEET_ZONES || "[]"); } catch { throw actionError("unavailable", "The brand domain configuration is invalid"); }
	if (!Array.isArray(zones)) throw actionError("unavailable", "The brand domain configuration is invalid");
	return zones.filter((entry) => entry.accountId === String(account._id) && typeof entry.zoneId === "string" && typeof entry.domain === "string");
}

const unquote = (value) => String(value ?? "").replace(/^"(.*)"$/, "$1");
const hostname = (value) => String(value).toLowerCase().replace(/\.$/, "");

function toRecord({ type, name, value }) {
	const record = { type, name: hostname(name), content: value, ttl: 1 };
	if (type === "CNAME") { record.content = hostname(value); record.proxied = false; }
	if (type === "MX") {
		const [priority, content] = String(value).split(/\s+/);
		record.priority = Number(priority);
		record.content = hostname(content);
	}
	return record;
}

function sameRecord(a, b) {
	return a.type === b.type && hostname(a.name) === b.name &&
		(a.type === "TXT" ? unquote(a.content) === unquote(b.content) : hostname(a.content) === hostname(b.content)) &&
		(b.priority === undefined || a.priority === b.priority) && !(b.type === "CNAME" && a.proxied);
}

async function planRecord(zone, wanted) {
	if (wanted.name !== zone.domain && !wanted.name.endsWith(`.${zone.domain}`)) throw actionError("forbidden", "A DNS record falls outside the configured brand domain");
	const existing = await listDnsRecords(zone.zoneId, { name: wanted.name });
	if (wanted.type === "TXT" && wanted.name.startsWith("_dmarc.")) {
		const policies = existing.filter((record) => record.type === "TXT" && /^v=DMARC1/i.test(unquote(record.content)));
		if (policies.length && getDmarcStatus(policies.map((record) => [unquote(record.content)])) === "found") return { wanted, existing: policies[0] };
	}
	const same = existing.find((record) => sameRecord(record, wanted));
	const conflicts = existing.filter((record) => record.id !== same?.id && (
		record.type === "CNAME" || wanted.type === "CNAME" ||
		(record.type === wanted.type && (wanted.type === "MX" || /^v=(spf1|DMARC1)/i.test(unquote(wanted.content))))
	));
	if (conflicts.length || (same?.type === "CNAME" && same.proxied)) throw actionError("conflict", `${wanted.type} ${wanted.name} has an existing record that needs review; nothing is overwritten`);
	return { wanted, existing: same ?? null };
}

// A brand's domain is a configured zone or a subdomain of one (newsletter.example.com sending for example.com). sendingOnly: no
// archive host, so no website record or Cloudflare hostname is made.
function normalizeBrand(account, input, zones) {
	const domain = normalizeDomainInput(input.domain);
	const sendingOnly = input.sendingOnly === true;
	if (sendingOnly && input.archiveHost) throw actionError("validation_failed", `${domain}: a sending-only domain has no archive host`);
	const archiveHost = sendingOnly ? null : normalizeHostInput(input.archiveHost) || `news.${domain}`;
	const problem = getDomainProblem(domain) || (archiveHost && getArchiveHostProblem(archiveHost, domain));
	if (problem) throw actionError("validation_failed", problem);
	if (archiveHost && !archiveHost.endsWith(`.${domain}`)) throw actionError("validation_failed", "The archive host must be within the approved brand domain");
	const zone = zones.filter((entry) => domain === entry.domain || domain.endsWith(`.${entry.domain}`)).sort((a, b) => b.domain.length - a.domain.length)[0];
	if (!zone) throw actionError("forbidden", `${domain} isn't configured for automatic DNS on this account`);
	return { domain, archiveHost, sendingOnly, zone };
}

export async function onboardBrandDomains(account, inputs) {
	if (!isCloudflareConfigured() || getEmailProvider().id !== "ses") throw actionError("unavailable", "Automatic brand domains need Cloudflare DNS and Amazon SES configured");
	const zones = getBrandZones(account);
	// Reject an unauthorized domain anywhere in the batch before touching any provider or DNS.
	const brands = inputs.map((input) => normalizeBrand(account, input, zones));
	if (new Set(brands.map(({ domain }) => domain)).size !== brands.length) throw actionError("validation_failed", "List each brand domain once");
	const results = [];
	for (const brand of brands) {
		const records = [];
		let domain;
		try {
			domain = await Domain.findOne(scoped(account, { domain: brand.domain })).lean();
			if (domain && (domain.archiveHost ?? null) !== brand.archiveHost) throw actionError("conflict", "The saved archive host differs; review it on the Domains page");
			domain = domain ? await checkDomain({ account, domainId: domain._id, verify: false }) : await addDomain({ account, domain: brand.domain, archiveHost: brand.archiveHost, sendingOnly: brand.sendingOnly });
			const inheritedDmarc = domain.dmarc?.status === "found" && domain.dmarc.host && domain.dmarc.host !== domain.domain;
			if (inheritedDmarc) records.push({ type: "TXT", name: `_dmarc.${domain.dmarc.host}`, state: "existing" });
			const wanted = getDomainSetup(domain, { cnameTarget: getArchiveCnameTarget() }).filter((step) => step.key !== "dmarc" || !inheritedDmarc).flatMap((step) => step.records).map(toRecord);
			const plan = [];
			for (const record of wanted) plan.push(await planRecord(brand.zone, record));
			for (const { wanted, existing } of plan) {
				const saved = existing ?? await createDnsRecord(brand.zone.zoneId, { ...wanted, comment: "FlockStack brand domain" });
				records.push({ type: wanted.type, name: wanted.name, state: existing || saved.existed ? "existing" : "created" });
			}
			domain = await checkDomain({ account, domainId: domain._id });
			results.push({ domain: brand.domain, id: String(domain._id), state: domain.verified && domain.dkimStatus === "SUCCESS" && domain.mailFromStatus === "SUCCESS" && domain.dmarc?.status === "found" && (!getArchiveCnameTarget() || !domain.archiveHost || domain.archiveHostVerified) ? "ready" : "pending", records, error: null });
		} catch (error) {
			// Keep successful records and the domain claim: retries reuse both, including after a provider timeout.
			results.push({ domain: brand.domain, id: domain ? String(domain._id) : null, state: "error", records, error: error.isActionError || error.isUserError ? error.message : "The provider didn't finish setup. Retry this domain; existing records are kept." });
		}
	}
	return { domains: results };
}
