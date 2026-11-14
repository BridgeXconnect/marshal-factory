import { drizzle } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";
import * as schema from "./schema";

const globalForPool = globalThis as unknown as { __pgPool?: Pool };

/** How long the pool waits on the network before it gives a connection up. */
export type PoolTimeouts = {
  /** A new connection, TLS included. */
  connectTimeoutMs: number;
  /** A query's reply, measured by the client; the connection is destroyed when it runs out. */
  queryTimeoutMs: number;
};

/**
 * Conservative: both are well above anything the runner or the panel asks of the database, so they
 * only fire on a connection that is dead or a query that has gone badly wrong.
 *  - connect: Neon answers a cold connect in a few seconds; a SYN into a network the machine's sleep
 *    broke gets nothing until the OS gives up after 75 s.
 *  - query: the heartbeat's own step timeout, so a dead connection is noticed within one step; no
 *    runner query is meant to run anywhere near it. It is measured by the client because the
 *    server's statement_timeout, sent as a startup parameter, is dropped by Neon's pooler.
 */
export const POOL_TIMEOUTS: PoolTimeouts = { connectTimeoutMs: 10_000, queryTimeoutMs: 60_000 };

/** Idle seconds before the kernel probes the peer; a dead one is torn down within a couple of minutes. */
export const KEEPALIVE_DELAY_MS = 30_000;

/**
 * The pool's settings; `max` stays 5. After the machine sleeps a socket can be dead without ever
 * erroring: a query on it would wait forever and keep its client checked out, and five of those
 * strand the pool until the process restarts. The timeouts bound every wait, and keepalive lets the
 * kernel notice a dead peer under an idle connection.
 */
export function poolConfig(connectionString: string, timeouts: PoolTimeouts = POOL_TIMEOUTS): PoolConfig {
  return {
    // Neon URLs say sslmode=require; verify-full keeps today's checks and skips pg's warning.
    connectionString: connectionString.replace("sslmode=require", "sslmode=verify-full"),
    max: 5,
    connectionTimeoutMillis: timeouts.connectTimeoutMs,
    query_timeout: timeouts.queryTimeoutMs,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
  };
}

function createPool() {
  const pool = new Pool(poolConfig(process.env.DATABASE_URL!));
  pool.on("error", (error) => console.error(error));
  // pg listens for errors only on idle clients: a socket that dies under a checked-out one, such as a
  // transaction's after the machine slept, would emit an unhandled error and end the process.
  pool.on("connect", (client) => client.on("error", (error) => console.error(error)));
  return pool;
}

// Reused across dev hot reloads so each reload doesn't leak a pool.
const pool = (globalForPool.__pgPool ??= createPool());

export const db = drizzle(pool, { schema });
