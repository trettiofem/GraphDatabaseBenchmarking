// The workloads, in portable Cypher. Engines replace individual queries via `Engine.overrides`.
import { config, type Tier } from './config.ts';
import type { Engine } from './engines/engine.ts';
import { type Counts, counts, ids, isoDate, randomAmount, randomDate, scaleOf } from './gen.ts';

export type Ctx = {
  r: () => number;
  c: Counts;
  id: ReturnType<typeof ids>;
  days: number; // date span of the loaded data
  runId: string;
  seq: number;
  created: string[]; // W1-created transaction ids, oldest first (W4 deletes from the front)
};

// `tag` keeps W1/W2 transaction ids unique across concurrent clients and runs.
export function context(tier: Tier, r: () => number, tag: string): Ctx {
  const c = counts(scaleOf(tier));
  return {
    r,
    c,
    id: ids(c),
    days: tier === 'S' ? 40 : 365,
    runId: `${Date.now().toString(36)}-${tag}`,
    seq: 0,
    created: [],
  };
}

export type Workload = {
  name: string;
  type: 'read' | 'write';
  cypher: string;
  params: (x: Ctx) => Record<string, unknown> | null; // null = nothing to do right now
};

const customer = (x: Ctx) => x.id.customer(Math.floor(x.r() * x.c.customers));
const account = (x: Ctx) => x.id.account(Math.floor(x.r() * x.c.accounts));
// Benchmark-created transactions get their own prefix so each step can remove them (see CLEANUP).
export const CREATED_PREFIX = 'TXN-';
export const CLEANUP = `MATCH (t:Transaction) WHERE t.id STARTS WITH '${CREATED_PREFIX}' WITH t LIMIT 10000 DETACH DELETE t RETURN count(*) AS c`;
const newTx = (x: Ctx) => {
  const id = `${CREATED_PREFIX}${x.runId}-${x.seq++}`;
  x.created.push(id);
  return { tx: id, from: account(x), to: account(x), amount: randomAmount(x.r), date: randomDate(x.r) };
};
const END = Date.UTC(2026, 9, 11);

export const WORKLOADS: Workload[] = [
  {
    name: 'R1_point_lookup',
    type: 'read',
    cypher: 'MATCH (c:Customer {id:$id}) RETURN c.id AS id, c.name AS name, c.country AS country',
    params: (x) => ({ id: customer(x) }),
  },
  {
    name: 'R2_customer_1hop',
    type: 'read',
    cypher: `MATCH (c:Customer {id:$id})
      OPTIONAL MATCH (c)-[:OWNS]->(a:Account)
      OPTIONAL MATCH (c)-[:USES]->(d:Device)
      RETURN c.id AS customer, a.id AS account, d.id AS device`,
    params: (x) => ({ id: customer(x) }),
  },
  {
    name: 'R3_recent_tx',
    type: 'read',
    cypher: `MATCH (:Account {id:$id})-[:SENT]->(t:Transaction)
      RETURN t.id AS id, t.amount AS amount, t.date AS date ORDER BY t.date DESC, t.id DESC LIMIT 20`,
    params: (x) => ({ id: account(x) }),
  },
  {
    name: 'R4_money_flow_4hop',
    type: 'read',
    cypher: `MATCH (:Account {id:$id})-[:SENT]->(:Transaction)-[:RECEIVED_BY]->(b:Account)-[:SENT]->(t2:Transaction)
      RETURN b.id AS via, t2.id AS tx, t2.amount AS amount ORDER BY tx LIMIT 100`,
    params: (x) => ({ id: account(x) }),
  },
  {
    name: 'R5_device_ring',
    type: 'read',
    cypher: `MATCH (c:Customer {id:$id})-[:USES]->(d:Device)<-[:USES]-(o:Customer)
      RETURN d.id AS device, o.id AS other`,
    params: (x) => ({ id: customer(x) }),
  },
  {
    name: 'R6_category_volume',
    type: 'read',
    cypher: `MATCH (t:Transaction)-[:RECEIVED_BY]->(m:Merchant) WHERE t.date >= $from AND t.date < $to
      RETURN m.category AS category, count(*) AS n, sum(t.amount) AS total ORDER BY category`,
    params: (x) => {
      const from = END - Math.floor(x.r() * Math.max(1, x.days - 30)) * 86_400_000 - 30 * 86_400_000;
      return { from: isoDate(from), to: isoDate(from + 30 * 86_400_000) };
    },
  },
  {
    name: 'R7_top_merchants',
    type: 'read',
    cypher: `MATCH (t:Transaction)-[:RECEIVED_BY]->(m:Merchant)
      RETURN m.id AS id, count(*) AS n, sum(t.amount) AS total ORDER BY total DESC, id LIMIT 10`,
    params: () => ({}),
  },
  {
    name: 'R8_shortest_path',
    type: 'read',
    // GQL shortest path; engines without `SHORTEST` override this (Memgraph uses *BFS).
    cypher: 'MATCH p = SHORTEST 1 (:Customer {id:$a})-[*..8]-(:Customer {id:$b}) RETURN length(p) AS hops',
    params: (x) => ({ a: customer(x), b: customer(x) }),
  },
  {
    name: 'R9_cycle_3to5',
    type: 'read',
    // Account -SENT-> Tx -RECEIVED_BY-> Account is 2 relationships per hop, so 3..5 hops = 6..10.
    cypher: 'MATCH p = (a:Account {id:$id})-[:SENT|RECEIVED_BY*6..10]->(a) RETURN count(p) AS cycles',
    params: (x) => ({ id: account(x) }),
  },
  {
    name: 'W1_create_tx',
    type: 'write',
    cypher: `MATCH (a:Account {id:$from}), (b:Account {id:$to})
      CREATE (a)-[:SENT]->(:Transaction {id:$tx, amount:$amount, date:$date})-[:RECEIVED_BY]->(b)`,
    params: newTx,
  },
  {
    name: 'W2_ingest_1k',
    type: 'write',
    cypher: `UNWIND $rows AS r MATCH (a:Account {id:r.from}), (b:Account {id:r.to})
      CREATE (a)-[:SENT]->(:Transaction {id:r.tx, amount:r.amount, date:r.date})-[:RECEIVED_BY]->(b)`,
    params: (x) => ({ rows: Array.from({ length: 1000 }, () => newTx(x)) }),
  },
  {
    name: 'W3_update_account',
    type: 'write',
    cypher: 'MATCH (a:Account {id:$id}) SET a.type = $type',
    params: (x) => ({ id: account(x), type: x.r() < 0.88 ? 'checking' : 'savings' }),
  },
  {
    name: 'W4_delete_oldest',
    type: 'write',
    cypher: 'MATCH (t:Transaction {id:$id}) DETACH DELETE t',
    // Lag 100 behind W1 so the delete never races the create of the same id.
    params: (x) => (x.created.length > 100 ? { id: x.created.shift() } : null),
  },
];

export const byName = (n: string) => {
  const w = WORKLOADS.find((w) => w.name.startsWith(n));
  if (!w) throw new Error(`unknown workload ${n}`);
  return w;
};
export const cypherFor = (w: Workload, engine: Engine) => engine.overrides[w.name] ?? w.cypher;

export type Mix = Array<[Workload, number]>;
const mix = (spec: Record<string, number>): Mix => Object.entries(spec).map(([n, wt]) => [byName(n), wt]);
const reads = (weight: number) => Object.fromEntries(['R1', 'R2', 'R3', 'R4', 'R5'].map((n) => [n, weight / 5]));

export const MIXES = {
  'read-heavy': () => mix({ ...reads(90), W1: 5, W3: 5 }),
  'write-heavy': () => mix({ ...reads(30), W1: 35, W3: 35 }),
  ingest: () => mix({ W2: 100 }),
  // W4 deletes at W1's rate so the graph size stays steady over hours.
  soak: () =>
    mix({ ...reads(config.soakReads), W1: config.soakCreates, W3: config.soakUpdates, W4: config.soakCreates }),
};
export const HEAVY = ['R4', 'R7', 'R8', 'R9'];

export function picker(m: Mix): (r: () => number) => Workload {
  const total = m.reduce((s, [, w]) => s + w, 0);
  return (r) => {
    let x = r() * total;
    for (const [w, wt] of m) {
      x -= wt;
      if (x < 0) return w;
    }
    return m[m.length - 1][0];
  };
}
