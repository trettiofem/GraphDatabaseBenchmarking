// The contract every database implements. Adding a database = one file in this folder,
// one line in index.ts, one docker compose service (see README "Adding a database").
import neo4j from 'neo4j-driver';
import { connection } from '../config.ts';

export type Row = Record<string, unknown>;
export type RunOpts = { write?: boolean; autoCommit?: boolean; timeoutMs?: number };

// Every engine runs the same three algorithms on the same subgraph,
// Account -SENT-> Transaction -RECEIVED_BY-> Account (directed), and returns:
//   A1_pagerank: [{id}] x 10, highest rank first (20 iterations, damping 0.85, tolerance 1e-7; ties by id)
//   A2_wcc:      [{components}]   number of weakly connected components
//   A3_louvain:  [{communities}]  number of communities (heuristic, compared loosely)
export const ALGOS = ['A1_pagerank', 'A2_wcc', 'A3_louvain'] as const;
export type AlgoName = (typeof ALGOS)[number];
/** `parts` holds milliseconds per stage and always includes `total`. */
export type AlgoResult = { rows: Row[]; parts: Record<string, number> };

export interface Engine {
  /** Registry key, docker compose service name and env prefix (NAME_URI, NAME_USER, NAME_PASSWORD). */
  readonly name: string;
  /** Data directory inside the container, sampled for store size. */
  readonly dataDir: string;
  /** Capacity phase: in-memory engines ingest until their memory limit, others to a multiple of that. */
  readonly inMemory: boolean;
  /** Index and constraint DDL, run before every load. "Already exists" errors are ignored. */
  readonly ddl: string[];
  /** Dialect-specific Cypher keyed by workload name, replacing the portable query in queries.ts. */
  readonly overrides: Partial<Record<string, string>>;
  /** Runs one query and returns plain row objects. Must enforce `timeoutMs` (server-side if possible). */
  run(cypher: string, params?: Row, opts?: RunOpts): Promise<Row[]>;
  /** True for errors worth retrying (write conflicts, deadlocks). Never true for timeouts. */
  retriable(err: unknown): boolean;
  algo(name: AlgoName): Promise<AlgoResult>;
  /** Version and settings that matter for fairness; written into every CSV header. */
  serverInfo(): Promise<Row>;
  /** Engine-reported memory in MiB, if the engine has its own accounting. */
  memory?(): Promise<{ used: number; limit: number }>;
  /** Releases freed memory before a measurement (e.g. Memgraph's FREE MEMORY). */
  settle?(): Promise<void>;
  close(): Promise<void>;
}

/** Shared client for engines that speak Bolt (Neo4j, Memgraph). */
export function bolt(name: string, poolSize: number) {
  const c = connection(name);
  const driver = neo4j.driver(c.uri, neo4j.auth.basic(c.user, c.password), {
    disableLosslessIntegers: true,
    maxConnectionPoolSize: poolSize,
    connectionAcquisitionTimeout: 120_000,
    // The runner retries instead (identically for every engine). The driver's own retries would hide
    // Memgraph timeouts, which use the same transient code as write conflicts, for 30 s.
    maxTransactionRetryTime: 0,
  });
  return {
    async run(cypher: string, params: Row = {}, opts: RunOpts = {}): Promise<Row[]> {
      if (opts.autoCommit) {
        // DDL and info queries: Memgraph rejects them inside explicit transactions.
        const session = driver.session();
        try {
          return (await session.run(cypher, params)).records.map((r) => r.toObject());
        } finally {
          await session.close();
        }
      }
      const { records } = await driver.executeQuery(cypher, params, {
        routing: opts.write === false ? neo4j.routing.READ : neo4j.routing.WRITE,
        transactionConfig: opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
      });
      return records.map((r) => r.toObject());
    },
    retriable(e: unknown) {
      const err = e as { retriable?: boolean; message?: string };
      return !!err.retriable && !/timeout|terminated/i.test(err.message ?? '');
    },
    close: () => driver.close(),
  };
}
