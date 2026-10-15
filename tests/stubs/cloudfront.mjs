// An in-memory CloudFront: invalidations are kept here instead of going to a distribution, with the settings of the
// client that asked for them.
export const invalidations = [];
// Distributions to refuse the way a policy without cloudfront:CreateInvalidation would.
export const refusedDistributions = new Set();

export function CloudFrontClient(config) {
	return {
		config,
		async send({ input }) {
			if (refusedDistributions.has(input.DistributionId)) {
				const message = `User is not authorized to perform: cloudfront:CreateInvalidation on resource: distribution/${input.DistributionId}`;
				throw Object.assign(new Error(message), { name: "AccessDenied" });
			}
			invalidations.push({ ...input, config });
			return { Invalidation: { Id: `I${invalidations.length}`, Status: "InProgress", InvalidationBatch: input.InvalidationBatch } };
		},
	};
}

export function CreateInvalidationCommand(input) {
	return { input };
}
