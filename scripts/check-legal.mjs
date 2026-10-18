// Lists the placeholders left in lib/legal.js and exits 1 while there are any: the legal pages stay hidden until it passes.
// scripts/deploy-all.mjs lists the same and deploys anyway. node scripts/check-legal.mjs
import { getLegalTodos } from "../lib/legal.js";

const todos = getLegalTodos();
if (todos.length === 0) {
	console.log("lib/legal.js has no placeholders left.");
} else {
	console.error(`lib/legal.js still has ${todos.length} placeholder${todos.length === 1 ? "" : "s"}:\n`);
	for (const [name, text] of todos) console.error(`  ${name}\n    ${text}\n`);
	process.exitCode = 1;
}
