import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { MongoClient } from "mongodb";

// Every test file starts its own mongod at once, so a slow machine gets time.
const STARTUP_TIMEOUT_MS = 60_000;

function getFreePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function isListening(port) {
	return new Promise((resolve) => {
		const socket = net.connect({ port, host: "127.0.0.1" });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => resolve(false));
	});
}

async function waitFor(check, what, deadline) {
	let lastError;
	while (Date.now() < deadline) {
		try {
			if (await check()) return;
		} catch (error) {
			lastError = error;
		}
		await sleep(100);
	}
	throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`);
}

function stopProcess(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => {
		child.once("exit", resolve);
		child.kill("SIGINT");
	});
}

// A throwaway mongod for one test file: a single-node replica set like Atlas, so transactions work.
// The driver backs off between failed connections, so it only connects once the port is open.
export async function startMongo() {
	const port = await getFreePort();
	const dbpath = await mkdtemp(join(tmpdir(), "mailcheap-test-"));
	const binary = process.env.MONGOD_PATH || "mongod";
	const child = spawn(binary, ["--dbpath", dbpath, "--port", String(port), "--bind_ip", "127.0.0.1", "--replSet", "rs0", "--quiet"], {
		stdio: "ignore",
	});
	let spawnError = null;
	child.once("error", (error) => {
		spawnError = new Error(`Integration tests need mongod on the PATH or in MONGOD_PATH (${error.message})`);
	});

	async function stop() {
		await stopProcess(child);
		await rm(dbpath, { recursive: true, force: true });
	}

	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	let client;
	try {
		await waitFor(
			async () => {
				if (spawnError) throw spawnError;
				return isListening(port);
			},
			"mongod to listen",
			deadline
		);
		client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 5000 });
		await client.db("admin").command({
			replSetInitiate: { _id: "rs0", members: [{ _id: 0, host: `127.0.0.1:${port}` }] },
		});
		await waitFor(async () => (await client.db("admin").command({ hello: 1 })).isWritablePrimary, "the replica set primary", deadline);
	} catch (error) {
		await stop();
		throw spawnError ?? error;
	} finally {
		await client?.close();
	}

	return { uri: `mongodb://127.0.0.1:${port}/mailcheap-test?directConnection=true`, stop };
}
