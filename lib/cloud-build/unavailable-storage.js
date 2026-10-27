// Stands in for the S3, CloudFront and Vercel Blob clients in the FlockStack Cloud build (FLOCKSTACK_CLOUD_BUILD=true: next.config.mjs and
// scripts/build-api-worker.mjs alias the three packages here). FlockStack Cloud keeps images in R2, so the clients are 2 MB it cannot reach;
// lib/image-storage.js loads each by import() only for a storage other than R2, and getImageStorageProblem refuses that first. Anything that
// still gets here fails with the reason instead of doing nothing. Exactly the names lib/image-storage.js takes from the three packages.
function unavailable() {
	throw new Error("This FlockStack Cloud build has no S3, CloudFront or Vercel Blob client: images are stored in R2 (IMAGES_STORAGE=r2)");
}

export const put = unavailable;
export const del = unavailable;

export class S3Client {
	constructor() {
		unavailable();
	}
}
export class PutObjectCommand {
	constructor() {
		unavailable();
	}
}
export class DeleteObjectsCommand {
	constructor() {
		unavailable();
	}
}
export class CloudFrontClient {
	constructor() {
		unavailable();
	}
}
export class CreateInvalidationCommand {
	constructor() {
		unavailable();
	}
}
