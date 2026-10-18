import { findVolumeFiles } from "@/lib/account-export";
import { verifyAccountExportToken } from "@/lib/account-export-token";
import { connectDb } from "@/lib/db";
import { getExportStore } from "@/lib/export-storage";
import { createZipStream, getZipSize, readStream } from "@/lib/zip";
import AccountExport from "@/models/AccountExport";

export const dynamic = "force-dynamic";

function fail(status, code, message) {
	return Response.json({ error: { code, message } }, { status });
}

// The file behind an account export's links, streamed from the export's files in storage. The signed token names the
// account and the export. It doesn't look at the account's plan or whether it is blocked: leaving is never held back.
export async function GET(request) {
	const params = new URL(request.url).searchParams;
	const link = verifyAccountExportToken(params.get("token"));
	if (!link) return fail(401, "unauthorized", "This download link is invalid or expired: export again");

	await connectDb();
	const exportDoc = await AccountExport.findOne({ _id: link.exportId, accountId: link.accountId }).lean();
	if (!exportDoc || exportDoc.status !== "ready" || new Date(exportDoc.expiresAt) < new Date()) {
		return fail(410, "not_found", "This export is gone: export again");
	}
	const volume = Number.parseInt(params.get("part") ?? "1", 10);
	const files = Number.isInteger(volume) && volume >= 1 ? await findVolumeFiles(exportDoc, volume) : null;
	if (!files) return fail(404, "not_found", "This export has no such part");
	const store = await getExportStore();
	if (!store) return fail(503, "unavailable", "The export's storage isn't reachable, try again in a minute");

	async function* read(file) {
		for (const key of file.keys ?? []) {
			const object = await store.get(key);
			if (!object) throw new Error(`${key} is missing from storage`);
			yield* readStream(object.body);
		}
	}
	const volumes = exportDoc.volumeStarts.length;
	const date = new Date(exportDoc.readyAt).toISOString().slice(0, 10);
	const name = `flockstack-export-${date}${volumes > 1 ? `-part-${volume}-of-${volumes}` : ""}.zip`;
	return new Response(createZipStream({ files: files.map(({ path, size, crc, keys }) => ({ path, size, crc, keys })), read, date: new Date(exportDoc.readyAt) }), {
		headers: {
			"content-type": "application/zip",
			"content-length": String(getZipSize(files)),
			"content-disposition": `attachment; filename="${name}"`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
		},
	});
}
