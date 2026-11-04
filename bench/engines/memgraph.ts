import type { AlgoName, Engine } from './engine.ts';
import { bolt } from './engine.ts';

const LABELS = ['Customer', 'Account', 'Device', 'Merchant', 'Transaction'];

// MAGE runs on the live graph; project() builds the subgraph inside the same query.
const SUBGRAPH = 'MATCH p=(:Account)-[:SENT]->(:Transaction)-[:RECEIVED_BY]->(:Account) WITH project(p) AS g';
const MAGE: Record<AlgoName, string> = {
  A1_pagerank: `${SUBGRAPH} CALL pagerank.get(g, 20, 0.85, 1e-7) YIELD node, rank
    RETURN node.id AS id ORDER BY rank DESC, id LIMIT 10`,
  A2_wcc: `${SUBGRAPH} CALL weakly_connected_components.get(g) YIELD component_id
    RETURN count(DISTINCT component_id) AS components`,
  A3_louvain: `${SUBGRAPH} CALL community_detection.get(g) YIELD community_id
    RETURN count(DISTINCT community_id) AS communities`,
};

const MIB: Record<string, number> = { B: 2 ** -20, KiB: 2 ** -10, MiB: 1, GiB: 1024, TiB: 2 ** 20 };
// Settings that matter for a fair comparison; copied into every CSV header.
const SETTINGS = [
  'storage_wal_file_flush_every_n_tx',
  'memory_limit',
  'storage_snapshot_interval_sec',
  'isolation_level',
  'query_execution_timeout_sec',
];

export function memgraphEngine(poolSize: number): Engine {
  const b = bolt('memgraph', poolSize);
  const freeMemory = async () => {
    await b.run('FREE MEMORY', {}, { autoCommit: true });
  };
  return {
    name: 'memgraph',
    dataDir: '/var/lib/memgraph',
    inMemory: true,
    // A Memgraph uniqueness constraint does not create an index, so both are needed.
    ddl: [
      ...LABELS.flatMap((l) => [`CREATE INDEX ON :${l}(id)`, `CREATE CONSTRAINT ON (n:${l}) ASSERT n.id IS UNIQUE`]),
      'CREATE INDEX ON :Transaction(date)',
    ],
    overrides: {
      R8_shortest_path:
        'MATCH p = (:Customer {id:$a})-[*BFS ..8]-(:Customer {id:$b}) RETURN size(relationships(p)) AS hops',
    },
    // Memgraph ignores the Bolt transaction timeout; compose sets --query-execution-timeout-sec instead.
    run: b.run,
    retriable: b.retriable,
    close: b.close,
    settle: freeMemory,
    async algo(name) {
      await freeMemory(); // untimed; MAGE once failed with `vector::reserve` right after mass deletes
      const t0 = performance.now();
      const rows = await b.run(MAGE[name]);
      return { rows, parts: { total: performance.now() - t0 } };
    },
    async memory() {
      const rows = await b.run('SHOW STORAGE INFO', {}, { autoCommit: true });
      const get = (k: string) => {
        const raw = String(rows.find((r) => r['storage info'] === k)?.value ?? '');
        const m = raw.match(/([\d.]+)\s*([KMGT]?i?B)/);
        if (!m) throw new Error(`cannot parse Memgraph ${k}: ${raw}`);
        return Number(m[1]) * MIB[m[2]];
      };
      return { used: get('memory_tracked'), limit: get('memory_limit') };
    },
    async serverInfo() {
      const [v] = await b.run('SHOW VERSION', {}, { autoCommit: true });
      const cfg = await b.run('SHOW CONFIG', {}, { autoCommit: true });
      return {
        version: v.version,
        ...Object.fromEntries(SETTINGS.map((k) => [k, cfg.find((r) => r.name === k)?.current_value])),
      };
    },
  };
}
