// The FlockStack server a connection talks to: the United States (flockstack.io), the European Union (eu.flockstack.io),
// or a self-hosted server's own address. An account lives in one region, and its API keys only work there.
const REGIONS = {
	us: "https://flockstack.io",
	eu: "https://eu.flockstack.io",
};

function getBaseUrl(authData = {}) {
	const own = String(authData.serverUrl || "").trim().replace(/\/+$/, "");
	if (own) return own;
	return REGIONS[authData.region] || REGIONS.us;
}

function apiUrl(bundle, path) {
	return `${getBaseUrl(bundle.authData)}/api/v1${path}`;
}

// Every request carries the key; FlockStack's errors ({ error: { code, message } }) become Zapier errors with its message.
function addApiKey(request, z, bundle) {
	if (bundle.authData && bundle.authData.apiKey) request.headers = { ...request.headers, Authorization: `Bearer ${bundle.authData.apiKey}` };
	return request;
}

function handleErrors(response, z) {
	if (response.request && response.request.skipThrowForStatus) return response;
	if (response.status === 401) throw new z.errors.RefreshAuthError("FlockStack refused the API key: check it, and that it belongs to this region.");
	if (response.status >= 400) {
		let message = `FlockStack answered ${response.status}`;
		try {
			const body = JSON.parse(response.content);
			if (body && body.error && body.error.message) message = body.error.message;
		} catch (error) {
			// Not JSON: the status says enough.
		}
		throw new z.errors.Error(message, response.status === 429 ? "ThrottledError" : "ApiError", response.status);
	}
	return response;
}

module.exports = { REGIONS, getBaseUrl, apiUrl, addApiKey, handleErrors };
