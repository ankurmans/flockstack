// An in-memory S3: objects are kept here instead of going to a bucket, with the settings of the client that put them.
export const objects = [];
export const clients = [];
// Keys deleted, and keys to refuse the way a bucket policy without s3:DeleteObject would.
export const deleted = [];
export const refusedDeletes = new Set();
// Keys read, with the settings of the client that read them.
export const reads = [];

export function S3Client(config) {
	const client = {
		config,
		async send(command) {
			if (command.type === "delete") return deleteObjects(command.input);
			if (command.type === "get") return getObject(command.input, config);
			objects.push({ ...command.input, bytes: command.input.Body.length, config });
			return { ETag: `"etag-${objects.length}"` };
		},
	};
	clients.push(client);
	return client;
}

function deleteObjects({ Bucket, Delete }) {
	const Errors = [];
	for (const { Key } of Delete.Objects) {
		if (refusedDeletes.has(Key)) {
			Errors.push({ Key, Code: "AccessDenied", Message: "Access Denied" });
			continue;
		}
		deleted.push({ Bucket, Key });
		const index = objects.findIndex((object) => object.Bucket === Bucket && object.Key === Key);
		if (index !== -1) objects.splice(index, 1);
	}
	return { Errors };
}

function getObject({ Bucket, Key }, config) {
	const object = objects.find((item) => item.Bucket === Bucket && item.Key === Key);
	if (!object) throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" });
	reads.push({ Bucket, Key, config });
	return { Body: { transformToByteArray: async () => new Uint8Array(object.Body) } };
}

export function PutObjectCommand(input) {
	return { input };
}

export function DeleteObjectsCommand(input) {
	return { type: "delete", input };
}

export function GetObjectCommand(input) {
	return { type: "get", input };
}
