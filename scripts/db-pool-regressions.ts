import "./test-guard";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { Pool } from "pg";
import { KEEPALIVE_DELAY_MS, POOL_TIMEOUTS, poolConfig } from "../db/client";

const url = process.env.DATABASE_URL!;

// The production settings: the pool size and the URL rewrite as before, every network wait bounded.
const production = poolConfig("postgres://u:p@h/db?sslmode=require");
assert.equal(production.max, 5, "the pool size is unchanged");
assert.equal(production.connectionString, "postgres://u:p@h/db?sslmode=verify-full");
assert.deepEqual(
  [production.connectionTimeoutMillis, production.query_timeout, production.keepAlive, production.keepAliveInitialDelayMillis],
  [10_000, 60_000, true, 30_000],
);
assert.equal(POOL_TIMEOUTS.queryTimeoutMs, 60_000, "a dead connection is noticed within one heartbeat step");

/** A socket that connects and then never answers a byte: what the machine's sleep leaves behind. */
const keepAliveCalls: unknown[][] = [];
function deadSocket() {
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  return Object.assign(socket, {
    connect: () => void setImmediate(() => socket.emit("connect")),
    setNoDelay: () => socket,
    setKeepAlive: (...args: unknown[]) => (keepAliveCalls.push(args), socket),
  });
}

// A connect that never completes is given up within the connect timeout, and the pool forgets the client.
const dead = new Pool({ ...poolConfig(url, { ...POOL_TIMEOUTS, connectTimeoutMs: 500 }), stream: deadSocket });
const connecting = Date.now();
await assert.rejects(dead.query("select 1"), /timeout/, "a connect that never completes is given up");
const connectTook = Date.now() - connecting;
assert.ok(connectTook < 5_000, `and within its own timeout, not the OS's: ${connectTook} ms`);
assert.equal(dead.totalCount, 0, "the dead client is gone from the pool");
assert.equal(dead.waitingCount, 0, "and nothing is left waiting on it");
assert.ok(keepAliveCalls.some(([on, delay]) => on === true && delay === KEEPALIVE_DELAY_MS), `keepalive was asked of the socket: ${JSON.stringify(keepAliveCalls)}`);
await dead.end();

// A reply that never comes: the client gives the query up, the connection is destroyed instead of
// going back to the pool checked out forever, and the next query gets a fresh one. pg_sleep stands
// in for the dead socket.
const silent = new Pool(poolConfig(url, { connectTimeoutMs: 10_000, queryTimeoutMs: 1_000 }));
try {
  assert.deepEqual((await silent.query("select 1 as one")).rows, [{ one: 1 }]);
  assert.equal(silent.totalCount, 1);
  await assert.rejects(silent.query("select pg_sleep(5)"), /Query read timeout/, "a reply that never comes is given up on by the client");
  assert.equal(silent.totalCount, 0, "and its connection is destroyed, not stranded in the pool");
  assert.deepEqual((await silent.query("select 2 as two")).rows, [{ two: 2 }], "the next query gets a fresh connection");
  assert.equal(silent.totalCount, 1);
} finally {
  await silent.end();
}

console.log("db pool: every network wait is bounded and a dead connection is replaced");
