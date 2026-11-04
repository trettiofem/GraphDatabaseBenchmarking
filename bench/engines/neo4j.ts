import type { AlgoName, Engine } from './engine.ts';
import { bolt } from './engine.ts';

const LABELS = ['Customer', 'Account', 'Device', 'Merchant', 'Transaction'];

// GDS needs an in-memory projection first; it is timed separately from the algorithm.
const GDS_PROJECT = `MATCH (a:Account)-[:SENT]->(t:Transaction)-[:RECEIVED_BY]->(b:Account)
  UNWIND [[a, t], [t, b]] AS e WITH gds.graph.project($g, e[0], e[1]) AS g RETURN g.nodeCount AS nodes`;
const GDS_DROP = 'CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName';
const GDS: Record<AlgoName, string> = {
  A1_pagerank: `CALL gds.pageRank.stream($g, {maxIterations:20, dampingFactor:0.85, tolerance:1e-7}) YIELD nodeId, score
    WITH gds.util.asNode(nodeId).id AS id, score RETURN id ORDER BY score DESC, id LIMIT 10`,
  A2_wcc: 'CALL gds.wcc.stats($g) YIELD componentCount RETURN componentCount AS components',
  A3_louvain: 'CALL gds.louvain.stats($g) YIELD communityCount RETURN communityCount AS communities',
};

export function neo4jEngine(poolSize: number): Engine {
  const b = bolt('neo4j', poolSize);
  return {
    name: 'neo4j',
    dataDir: '/data',
    inMemory: false,
    ddl: [
      ...LABELS.map((l) => `CREATE CONSTRAINT ${l.toLowerCase()}_id IF NOT EXISTS FOR (n:${l}) REQUIRE n.id IS UNIQUE`),
      'CREATE INDEX tx_date IF NOT EXISTS FOR (t:Transaction) ON (t.date)',
    ],
    overrides: {}, // queries.ts is written in Neo4j's dialect (GQL `SHORTEST` for R8)
    run: b.run,
    retriable: b.retriable,
    close: b.close,
    async algo(name) {
      const g = `bench-${name}`;
      await b.run(GDS_DROP, { g }); // leftover from an interrupted run
      const t0 = performance.now();
      await b.run(GDS_PROJECT, { g });
      const t1 = performance.now();
      const rows = await b.run(GDS[name], { g });
      const t2 = performance.now();
      await b.run(GDS_DROP, { g });
      return { rows, parts: { project: t1 - t0, run: t2 - t1, total: performance.now() - t0 } };
    },
    async serverInfo() {
      const [v] = await b.run('CALL dbms.components() YIELD versions RETURN versions[0] AS version');
      return { version: v.version };
    },
  };
}
