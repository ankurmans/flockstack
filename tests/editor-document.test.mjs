import assert from "node:assert/strict";
import { test } from "node:test";
import { documentContent, documentFromState, newDocument, stateBase64 } from "../workers/collaboration/document.js";
import * as Y from "yjs";
test("canonical collaborative serialization retains rich code, tables, callouts and paid audience boundaries", () => {
	const html = '<h2>Section</h2><p><strong>Bold</strong> and <a href="https://example.com/?a=1&amp;b=2">Link</a></p><pre><code class="language-js">const sample = &quot;&lt;safe&gt;&quot;;</code></pre><div data-callout=""><p>Callout</p></div><div data-access="paid" data-min-tier="patron"><p>PRIVATE_PAID_BODY</p></div><table><tbody><tr><td><p>Cell</p></td></tr></tbody></table><p><img src="https://example.com/image.png" alt="Synthetic image"></p>';
	const doc = newDocument({ subject: "Rich subject", previewText: "Preview", html }), output = documentContent(doc);
	for (const pattern of [/<h2>Section<\/h2>/, /<strong>Bold<\/strong>/, /language-js/, /&lt;safe&gt;/, /data-callout/, /data-access="paid"/, /data-min-tier="patron"/, /PRIVATE_PAID_BODY/, /<table/, /Cell/, /alt="Synthetic image"/]) assert.match(output.html, pattern);
	const restored = documentContent(documentFromState(stateBase64(doc))); assert.deepEqual(restored, output);
});
test("unsupported shared document nodes and oversized subjects cannot become a canonical checkpoint", () => {
	const doc = newDocument({ subject: "Valid", html: "<p>Body</p>" }); doc.getText("subject").insert(0, "x".repeat(201)); assert.throws(() => documentContent(doc), /too large/);
	const invalid = new Y.Doc(), node = new Y.XmlElement("script"); node.insert(0, [new Y.XmlText("Not allowed")]); invalid.getXmlFragment("default").insert(0, [node]); assert.throws(() => documentContent(invalid));
});
