// The one line a site adds to show a form: <script async src="https://<newsletter host>/embed.js" data-flockstack-form="<id>">.
// It puts a frame of the form's page (/embed/<id>) where the script stands, hands the frame the page's address and UTM
// parameters, and sets the frame's height from the messages the form sends. A message counts only from the form's own
// origin and its own frame; the only things it can ask for are a height and a redirect to an https page the owner chose.
// Plain ES5 on purpose: it runs in whatever browser opens the site.
export const EMBED_SCRIPT = `(function () {
	var script = document.currentScript;
	if (!script) {
		var all = document.getElementsByTagName("script");
		for (var i = all.length - 1; i >= 0; i--) {
			if (all[i].getAttribute("data-flockstack-form") && !all[i].getAttribute("data-flockstack-ready")) { script = all[i]; break; }
		}
	}
	if (!script || script.getAttribute("data-flockstack-ready")) return;
	var id = script.getAttribute("data-flockstack-form") || "";
	if (!/^[a-f0-9]{24}$/i.test(id)) return;
	script.setAttribute("data-flockstack-ready", "1");
	var origin;
	try { origin = new URL(script.src).origin; } catch (error) { return; }

	var query = ["parent=" + encodeURIComponent(location.origin)];
	var params = new URLSearchParams(location.search);
	["source", "medium", "campaign", "term", "content"].forEach(function (key) {
		var value = params.get("utm_" + key);
		if (value) query.push("utm_" + key + "=" + encodeURIComponent(value.slice(0, 100)));
	});

	var frame = document.createElement("iframe");
	frame.src = origin + "/embed/" + id + "?" + query.join("&");
	frame.title = script.getAttribute("data-title") || "Subscribe";
	frame.setAttribute("scrolling", "no");
	frame.setAttribute("loading", "lazy");
	frame.style.cssText = "width:100%;border:0;display:block;color-scheme:light;height:" + (Number(script.getAttribute("data-height")) || 120) + "px";
	script.parentNode.insertBefore(frame, script.nextSibling);

	window.addEventListener("message", function (event) {
		if (event.origin !== origin || event.source !== frame.contentWindow) return;
		var data = event.data;
		if (!data || data.source !== "flockstack-form" || data.form !== id) return;
		if (data.type === "resize" && typeof data.height === "number" && data.height > 0) {
			frame.style.height = Math.min(Math.ceil(data.height), 2000) + "px";
		} else if (data.type === "redirect" && typeof data.url === "string" && /^https:\\/\\//i.test(data.url)) {
			location.href = data.url;
		}
	});
})();
`;
