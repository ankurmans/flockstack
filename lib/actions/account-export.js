import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { actionError } from "@/lib/actions/errors";
import { dateOutput, idInput, toIso } from "@/lib/actions/shared";
import { findExport, findLatestExport, getExportDownloadUrls, startAccountExport } from "@/lib/account-export";
import { EXPORT_LINK_DAYS } from "@/lib/account-export-files";
import { EXPORT_STATUSES } from "@/models/AccountExport";

const GROUP = "Export";

const ExportSchema = z.object({
	id: z.string(),
	status: z
		.enum(EXPORT_STATUSES)
		.describe("queued and running: still being made. ready: the download links work. failed: it stopped, export again. expired: the links ran out."),
	createdAt: dateOutput,
	readyAt: dateOutput,
	expiresAt: dateOutput.describe(`When the download links stop working: ${EXPORT_LINK_DAYS} days after the export is ready`),
	downloadUrls: z
		.array(z.string())
		.describe("One link per ZIP file, once the export is ready: usually one, several for a very large account. No key is needed to open them; anyone with the link can download until it expires."),
	counts: z.object({
		newsletters: z.number().int(),
		contacts: z.number().int(),
		campaigns: z.number().int(),
		images: z.number().int(),
		missingImages: z.number().int().describe("Pictures that could no longer be fetched from storage"),
		bytes: z.number().int().describe("Size of everything in the export"),
	}),
	error: z.string().nullable(),
	emailed: z.boolean().describe("The account owner got the links by email"),
});

function toExport(exportDoc) {
	return {
		id: String(exportDoc._id),
		status: exportDoc.status,
		createdAt: toIso(exportDoc.createdAt),
		readyAt: toIso(exportDoc.readyAt),
		expiresAt: toIso(exportDoc.expiresAt),
		downloadUrls: getExportDownloadUrls(exportDoc),
		counts: {
			newsletters: exportDoc.counts?.newsletters ?? 0,
			contacts: exportDoc.counts?.contacts ?? 0,
			campaigns: exportDoc.counts?.campaigns ?? 0,
			images: exportDoc.counts?.images ?? 0,
			missingImages: exportDoc.counts?.missingImages ?? 0,
			bytes: exportDoc.counts?.bytes ?? 0,
		},
		error: exportDoc.error ?? null,
		emailed: Boolean(exportDoc.emailedAt),
	};
}

const exportAccountData = defineAction({
	name: "export_account_data",
	title: "Export all account data",
	group: GROUP,
	description: `Starts an export of everything the account has, as ZIP files: every newsletter's contacts as a CSV (status, source, signup dates, engagement, tags), the suppression list, every issue and draft as Markdown and HTML with frontmatter (title, date, newsletter, archive address, status), the pictures they use, and a manifest.json that lists it all with each newsletter's settings. It is built in the background, which can take minutes for a large account; the account owner gets the download links by email, and get_account_export answers with them once status is ready. The links work for ${EXPORT_LINK_DAYS} days. Leaving is never a paid feature: it works for blocked accounts, paused ones and accounts without a plan. While an export is being made, calling this again answers that export with started false.`,
	http: { method: "POST", path: "/account/export", status: 202 },
	requiresPlan: false,
	whileBlocked: true,
	openWorld: true,
	rateLimit: { limit: 1, window: "5 m" },
	limitDashboard: true,
	input: z.object({}),
	output: ExportSchema.extend({ started: z.boolean().describe("False when an export was already being made and this is it") }),
	handler: async ({ account, user, via }) => {
		const { exportDoc, isNew } = await startAccountExport({ account, user, via });
		return { ...toExport(exportDoc), started: isNew };
	},
});

const getAccountExport = defineAction({
	name: "get_account_export",
	title: "Get an account export",
	group: GROUP,
	description: "Gets an account export by ID, or the latest one: its status and, once it is ready, the download links. Works for blocked accounts and accounts without a plan.",
	http: { method: "GET", path: "/account/export" },
	requiresPlan: false,
	readOnly: true,
	input: z.object({ id: idInput("export").optional().describe("The export's ID. Default: the latest one.") }),
	output: ExportSchema,
	handler: async ({ account, input }) => {
		const exportDoc = input.id ? await findExport(account, input.id) : await findLatestExport(account);
		if (!exportDoc) throw actionError("not_found", input.id ? "Export not found" : "There's no export yet: start one with export_account_data");
		return toExport(exportDoc);
	},
});

export const exportActions = [exportAccountData, getAccountExport];
