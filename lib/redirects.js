import "server-only";
import Papa from "papaparse";
import { scoped } from "@/lib/account-scope";
import { MAX_REDIRECTS_PER_NEWSLETTER, MAX_REDIRECT_CSV_ROWS, isReservedRedirectPath, normalizeRedirectPath, normalizeRedirectTarget } from "@/lib/redirect-paths";
import Redirect from "@/models/Redirect";

const MAX_REPORTED_PROBLEMS = 20;

function redirectError(message, code = "validation_failed") {
	return Object.assign(new Error(message), { code });
}

// A rule's from and to as they are stored, or the reason they can't be.
export function readRedirect(from, to) {
	const path = normalizeRedirectPath(from);
	if (!path) return { problem: "from must be a path on your website, like /p/old-post" };
	if (isReservedRedirectPath(path)) return { problem: `${path} is a page of your website and can't redirect` };
	const target = normalizeRedirectTarget(to);
	if (!target) return { problem: "to must be a path on your website (/p/new-post) or an https:// address" };
	if (target.startsWith("/") && normalizeRedirectPath(target) === path) return { problem: "A redirect can't lead to its own path" };
	return { path, to: target };
}

export function countRedirects(account, newsletterId) {
	return Redirect.countDocuments(scoped(account, { newsletterId }));
}

export async function addRedirect({ account, newsletterId, from, to }) {
	const rule = readRedirect(from, to);
	if (rule.problem) throw redirectError(rule.problem);
	if ((await countRedirects(account, newsletterId)) >= MAX_REDIRECTS_PER_NEWSLETTER) {
		throw redirectError(`A website can have ${MAX_REDIRECTS_PER_NEWSLETTER.toLocaleString("en-US")} redirects`);
	}
	if (await Redirect.exists(scoped(account, { newsletterId, path: rule.path }))) {
		throw redirectError(`${rule.path} already redirects: remove that one first`, "conflict");
	}
	try {
		return (await Redirect.create({ accountId: account._id, newsletterId, path: rule.path, to: rule.to, source: "manual" })).toObject();
	} catch (error) {
		if (error?.code === 11000) throw redirectError(`${rule.path} already redirects: remove that one first`, "conflict");
		throw error;
	}
}

// Two columns, from and to, with or without a header row. A from that already redirects takes the new target.
export function parseRedirectCsv(text) {
	const { data } = Papa.parse(String(text ?? "").trim(), { skipEmptyLines: true });
	const rows = data.map((cells, index) => ({ line: index + 1, from: String(cells[0] ?? "").trim(), to: String(cells[1] ?? "").trim() }));
	if (rows[0] && !normalizeRedirectTarget(rows[0].to) && /^(from|old|source|path)/i.test(rows[0].from)) rows.shift();
	return rows;
}

export async function importRedirects({ account, newsletterId, csv }) {
	const rows = parseRedirectCsv(csv);
	if (rows.length > MAX_REDIRECT_CSV_ROWS) throw redirectError(`Send ${MAX_REDIRECT_CSV_ROWS} rows at most at a time`);
	const problems = [];
	const rules = new Map();
	for (const row of rows) {
		const rule = readRedirect(row.from, row.to);
		if (rule.problem) problems.push({ line: row.line, problem: rule.problem });
		else rules.set(rule.path, rule.to);
	}
	const existing = new Set(
		(await Redirect.find(scoped(account, { newsletterId, path: { $in: [...rules.keys()] } })).select({ path: 1 }).lean()).map(({ path }) => path)
	);
	const added = [...rules.keys()].filter((path) => !existing.has(path)).length;
	if (added > 0 && (await countRedirects(account, newsletterId)) + added > MAX_REDIRECTS_PER_NEWSLETTER) {
		throw redirectError(`A website can have ${MAX_REDIRECTS_PER_NEWSLETTER.toLocaleString("en-US")} redirects`);
	}
	if (rules.size > 0) {
		await Redirect.bulkWrite(
			[...rules].map(([path, to]) => ({
				updateOne: {
					filter: { accountId: account._id, newsletterId, path },
					update: { $set: { to, source: "manual" }, $unset: { importId: 1, campaignId: 1 } },
					upsert: true,
				},
			}))
		);
	}
	return { added, updated: rules.size - added, invalid: problems.length, problems: problems.slice(0, MAX_REPORTED_PROBLEMS) };
}

// The automatic rule from an imported post's old address to its new page. A rule the owner set by hand stays as it is.
export async function saveImportRedirect({ accountId, newsletterId, oldPath, campaign, importId }) {
	const path = normalizeRedirectPath(oldPath);
	const to = `/p/${campaign.archiveSlug}`;
	if (!path || isReservedRedirectPath(path) || path === to) return false;
	const { upsertedCount } = await Redirect.updateOne(
		{ accountId, newsletterId, path },
		{ $setOnInsert: { to, source: "import", importId, campaignId: campaign._id } },
		{ upsert: true }
	);
	return upsertedCount > 0;
}
