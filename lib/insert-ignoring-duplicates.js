// insertMany that skips the documents a unique index already has, so a step that runs twice writes each once.
export async function insertIgnoringDuplicates(Model, documents) {
	if (documents.length === 0) return;
	try {
		await Model.insertMany(documents, { ordered: false });
	} catch (error) {
		const codes = (error?.writeErrors ?? []).map(({ err, code }) => err?.code ?? code);
		if (!(codes.length > 0 ? codes.every((code) => code === 11000) : error?.code === 11000)) throw error;
	}
}
