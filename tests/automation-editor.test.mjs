import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addStep, canMoveStep, fromApiSteps, hasEndingStep, moveStep, newStep, removeStep, toApiSteps, updatePath, updateStep } from "../lib/automation-editor.js";

// The dashboard editor's tree: steps as the API shows them become steps the editor changes, and go back as the steps
// update_automation takes, keeping every ID.
const FIELDS = [
	{ key: "seats", type: "number" },
	{ key: "beta", type: "boolean" },
	{ key: "topics", type: "list", multiple: true, options: ["news", "tips"] },
	{ key: "plan", type: "text" },
];

const SHOWN = [
	{ id: "e1", type: "email", subject: "Hi", previewText: "", format: "markdown", content: "Hello **you**" },
	{ id: "w1", type: "wait", amount: 2, unit: "days" },
	{ id: "w2", type: "wait", until: "2026-12-01T09:00:00Z" },
	{ id: "w3", type: "wait", weekday: "friday", time: "10:30", timeZone: "Europe/Paris" },
	{ id: "f1", type: "set_field", field: "plan", value: "pro" },
	{ id: "f2", type: "set_field", field: "plan", value: null },
	{ id: "h1", type: "webhook", name: "crm" },
	{
		id: "b1",
		type: "branch",
		condition: { match: "all", conditions: [{ type: "tag", op: "has", value: "vip" }] },
		paths: [
			{ name: "Yes", steps: [{ id: "t1", type: "add_tag", tag: "a" }] },
			{
				steps: [
					{
						id: "s1",
						type: "split",
						seed: "launch",
						paths: [
							{ percent: 60, steps: [{ id: "m1", type: "move", automation: "6650f1c2e9b1d4a012345678" }] },
							{ percent: 40, steps: [{ id: "x1", type: "end" }] },
						],
					},
				],
			},
		],
	},
];

describe("the editor's steps", () => {
	test("go back to the API's form with every ID, however deep", () => {
		const editor = fromApiSteps(SHOWN);
		assert.ok(editor.every(({ _key }) => _key));
		assert.equal(new Set(JSON.stringify(editor).match(/"_key":"k\d+"/g)).size, 16, "a key for every step and every path");
		const back = toApiSteps(editor, FIELDS);
		assert.equal(back[0].format, "rich");
		assert.match(back[0].content, /<strong>you<\/strong>/, "Markdown is edited as rich text");
		const without = (steps) => JSON.parse(JSON.stringify(steps, (key, value) => (["format", "content"].includes(key) ? undefined : value)));
		assert.deepEqual(without(back), without(SHOWN), "the rest comes back as it was shown");
	});

	test("read a wait in each of its forms, and a field's value by the field's type", () => {
		const waits = toApiSteps(fromApiSteps(SHOWN.slice(1, 4)));
		assert.deepEqual(waits, SHOWN.slice(1, 4), "the same moment, to the minute");
		const edited = fromApiSteps([{ id: "w2", type: "wait", until: "2026-12-01T09:00:00.000Z" }]);
		assert.equal(edited[0].until, "2026-12-01T09:00", "the input shows UTC");
		assert.deepEqual(toApiSteps(updateStep(edited, edited[0]._key, { until: "2027-01-02T03:04" })), [{ id: "w2", type: "wait", until: "2027-01-02T03:04:00Z" }]);

		const set = (field, value, extra = {}) => toApiSteps([{ ...newStep("set_field"), field, value, ...extra }], FIELDS)[0].value;
		assert.equal(set("seats", "12"), 12);
		assert.equal(set("beta", "true"), true);
		assert.equal(set("beta", "false"), false);
		assert.deepEqual(set("topics", "news, tips"), ["news", "tips"]);
		assert.equal(set("plan", "pro"), "pro");
		assert.equal(set("plan", "pro", { isClearing: true }), null, "clearing sends null whatever was typed");
		assert.equal(fromApiSteps([SHOWN[5]])[0].isClearing, true);
	});

	test("start a branch with a condition to fill in and two empty paths, and a split with two halves", () => {
		const branch = newStep("branch");
		assert.equal(branch.mode, "condition");
		assert.equal(branch.paths.length, 2);
		assert.deepEqual(branch.rulesState.items.length, 1);
		assert.deepEqual(toApiSteps([branch])[0].paths, [{ steps: [] }, { steps: [] }]);
		const split = newStep("split");
		assert.deepEqual(toApiSteps([split])[0].paths.map(({ percent }) => percent), [50, 50]);
		const bySegment = { ...branch, mode: "segment", segment: "6650f1c2e9b1d4a012345678" };
		const [stored] = toApiSteps([bySegment]);
		assert.deepEqual([stored.segment, stored.condition], ["6650f1c2e9b1d4a012345678", undefined]);
		assert.deepEqual(toApiSteps(fromApiSteps([{ id: "b", type: "branch", segment: "6650f1c2e9b1d4a012345678", paths: [{ steps: [] }, { steps: [] }] }]))[0].segment, "6650f1c2e9b1d4a012345678");
	});

	test("add, change, move and remove steps at any level without touching the steps they were made from", () => {
		const steps = fromApiSteps(SHOWN);
		const before = JSON.stringify(steps);
		const branch = steps.at(-1);
		const [yes, no] = branch.paths;

		const added = addStep(steps, { stepKey: branch._key, pathKey: yes._key }, newStep("add_tag"));
		assert.equal(added.at(-1).paths[0].steps.length, 2);
		assert.equal(addStep(steps, null, newStep("end")).length, steps.length + 1);

		const renamed = updatePath(steps, branch._key, no._key, { name: "Everyone else" });
		assert.equal(renamed.at(-1).paths[1].name, "Everyone else");
		const split = no.steps[0];
		const resized = updatePath(steps, split._key, split.paths[0]._key, { percent: 30 });
		assert.equal(resized.at(-1).paths[1].steps[0].paths[0].percent, 30);
		assert.equal(updateStep(steps, yes.steps[0]._key, { tag: "b" }).at(-1).paths[0].steps[0].tag, "b");

		const without = removeStep(steps, split._key);
		assert.deepEqual(without.at(-1).paths[1].steps, []);
		assert.equal(removeStep(steps, steps[0]._key).length, steps.length - 1);

		assert.equal(JSON.stringify(steps), before, "nothing was changed in place");
	});

	test("keep a branch or a split at the end of its list", () => {
		const steps = fromApiSteps([SHOWN[0], SHOWN[1], SHOWN.at(-1)]);
		const [email, wait, branch] = steps;
		assert.equal(canMoveStep(steps, email._key, -1), false, "first");
		assert.equal(canMoveStep(steps, email._key, 1), true);
		assert.equal(canMoveStep(steps, wait._key, 1), false, "not past the branch");
		assert.equal(canMoveStep(steps, branch._key, -1), false, "a branch stays last");
		assert.deepEqual(moveStep(steps, email._key, 1).map(({ id }) => id), ["w1", "e1", "b1"]);
		assert.deepEqual(moveStep(steps, wait._key, 1).map(({ id }) => id), ["e1", "w1", "b1"], "refused: the list is as it was");
		const inPath = fromApiSteps([{ id: "b", type: "branch", segment: "6650f1c2e9b1d4a012345678", paths: [{ steps: [{ id: "a", type: "end" }, { id: "c", type: "end" }] }, { steps: [] }] }]);
		const [a] = inPath[0].paths[0].steps;
		assert.deepEqual(moveStep(inPath, a._key, 1)[0].paths[0].steps.map(({ id }) => id), ["c", "a"], "inside a path too");
		assert.equal(canMoveStep(inPath, "nope", 1), false);

		assert.equal(hasEndingStep(steps), true);
		assert.equal(hasEndingStep(steps.slice(0, 2)), false);
		assert.equal(hasEndingStep([]), false);
	});
});
