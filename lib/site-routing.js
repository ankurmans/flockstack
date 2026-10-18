// What proxy.js needs from FlockStack Cloud's marketing site, apart from lib/site-extensions.js: the middleware bundles
// everything its imports reach, and the extensions load the support assistant and through it the AWS SDK.
// next.config.mjs and tests/setup/hooks.mjs resolve this module to lib/marketing/site-routing.js when that file exists.
// This default, the open source's, adds nothing.
export const siteRouting = {
	// proxy.js renders landingPath at / for signed-out visitors and lets publicPages, and the paths isPublicPath
	// accepts, open without a session; a self-hosted server answers 404 for them.
	landingPath: null,
	publicPages: [],
	isPublicPath: () => false,
};
