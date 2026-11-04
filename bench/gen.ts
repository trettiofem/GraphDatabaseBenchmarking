// Deterministic mock-data generator + loader. Tier S is dataset.cypher verbatim;
// M and L scale its shape (same ID formats, label ratios and value ranges) and add hubs + fraud patterns.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { config, type Tier } from './config.ts';
import type { Engine } from './engines/engine.ts';
import { log } from './log.ts';

export function rng(seed: number): () => number {
  let a = seed >>> 0; // mulberry32
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Power-law-ish pick in [0, n): exponent > 1 piles picks onto low indexes, creating hub nodes.
const skew = (r: () => number, n: number, exp: number) => Math.floor(n * r() ** exp);
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

export const scaleOf = (tier: Tier) => ({ S: 1, M: config.scaleM, L: config.scaleL })[tier];

// Label ratios of dataset.cypher; merchants grow with sqrt(scale) so they stay hubs.
export function counts(scale: number) {
  return {
    customers: 71 * scale,
    accounts: 81 * scale,
    devices: 62 * scale,
    merchants: Math.round(13 * Math.sqrt(scale)),
    transactions: 283 * scale,
  };
}
export type Counts = ReturnType<typeof counts>;

const pad = (i: number, max: number, min: number) => String(i + 1).padStart(Math.max(min, String(max).length), '0');
export function ids(c: Counts) {
  return {
    customer: (i: number) => `C${pad(i, c.customers, 3)}`,
    account: (i: number) => `ACC-${pad(i, c.accounts, 3)}`,
    device: (i: number) => `DEV-${pad(i, c.devices, 3)}`,
    merchant: (i: number) => `M${pad(i, c.merchants, 2)}`,
    tx: (i: number) => `TX-${pad(i, c.transactions, 3)}`,
  };
}

const FIRST = [
  'Alma',
  'Amir',
  'Bruno',
  'Chloe',
  'Clara',
  'Elsa',
  'Felix',
  'Hana',
  'Ines',
  'Ivan',
  'Jonas',
  'Karim',
  'Lena',
  'Lucas',
  'Marco',
  'Maya',
  'Mira',
  'Nadia',
  'Noah',
  'Olivia',
  'Oskar',
  'Pavel',
  'Priya',
  'Rosa',
  'Sofia',
  'Sven',
  'Tara',
  'Tomas',
  'Viktor',
  'Yara',
  'Yuki',
  'Zane',
  'Zoe',
];
const LAST = [
  'Andersen',
  'Berg',
  'Brandt',
  'Cohen',
  'Duarte',
  'Dubois',
  'Eriksen',
  'Fischer',
  'Hansen',
  'Holm',
  'Ivanova',
  'Kowalski',
  'Larsen',
  'Lindqvist',
  'Lopez',
  'Lund',
  'Mehta',
  'Mendes',
  'Moreau',
  'Nair',
  'Nilsson',
  'Okafor',
  'Park',
  'Petrov',
  'Rossi',
  'Santos',
  'Sato',
  'Silva',
  'Tanaka',
  'Varga',
  'Vogel',
  'Weiss',
  'Zielinski',
];
const COUNTRIES = ['SE', 'SE', 'SE', 'ES', 'ES', 'DE', 'DE', 'FR', 'FR', 'GB', 'GB', 'PL'];
const OS = ['android', 'ios', 'web'];
const M_ADJ = [
  'Harbor',
  'Northline',
  'Pixel',
  'Cedar',
  'Blue Kettle',
  'Stride',
  'Atlas',
  'Orchard',
  'Volt',
  'Moss',
  'Summit',
  'Tide',
  'Lumen',
];
const M_NOUN = [
  'Grocers',
  'Fuel',
  'Parlour',
  'Pharmacy',
  'Cafe',
  'Sports',
  'Air',
  'Books',
  'Electronics',
  'Bakery',
  'Gym',
  'Laundry',
  'Exchange',
];
const CATEGORIES = [
  'grocery',
  'fuel',
  'games',
  'health',
  'food',
  'food',
  'retail',
  'retail',
  'retail',
  'travel',
  'fitness',
  'services',
  'crypto',
];
const END = Date.UTC(2026, 9, 11); // last date in dataset.cypher
const DAY = 86_400_000;

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const randomDate = (r: () => number) => isoDate(END - Math.floor(r() * 365) * DAY);
export function randomAmount(r: () => number) {
  const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()); // log-normal, like the dataset's 6..13150
  return Math.round(Math.min(13150, Math.max(6, Math.exp(Math.log(250) + 1.2 * z))) * 100) / 100;
}

// Injected fraud patterns, from their own RNG so validate can recompute them without regenerating everything.
export function injected(scale: number) {
  const c = counts(scale);
  const r = rng(config.seed + 1000);
  const rings: number[][] = []; // customer indexes sharing one ring device (~1% of customers)
  for (let i = 0; i < Math.max(1, Math.floor((c.customers * 0.01) / 5.5)); i++) {
    const members = new Set<number>();
    const size = 3 + Math.floor(r() * 6);
    while (members.size < size) members.add(Math.floor(r() * c.customers));
    rings.push([...members]);
  }
  const cycles: number[][] = []; // account indexes forming a money cycle a1 -> a2 -> ... -> a1
  for (let i = 0; i < Math.max(1, Math.floor(c.accounts * 0.002)); i++) {
    const members = new Set<number>();
    const size = 3 + Math.floor(r() * 3);
    while (members.size < size) members.add(Math.floor(r() * c.accounts));
    cycles.push([...members]);
  }
  return { rings, cycles, ringDevice: (i: number) => `DEV-R${i + 1}` };
}

type Row = Record<string, string | number>;
type Stream = { name: string; cypher: string; rows: () => Iterable<Row> };

export function streams(scale: number): Stream[] {
  const c = counts(scale);
  const id = ids(c);
  const inj = injected(scale);
  const seeded = (k: number) => rng(config.seed + k);
  const txRow = (r: () => number, i: number, from: number, to: number | null): Row => {
    const toMerchant = to === null;
    return {
      id: id.tx(i),
      amount: randomAmount(r),
      date: randomDate(r),
      from: id.account(from),
      to: toMerchant ? id.merchant(skew(r, c.merchants, 2)) : id.account(to),
      kind: toMerchant ? 'Merchant' : 'Account',
    };
  };
  return [
    {
      name: 'Customer',
      cypher: 'UNWIND $rows AS r CREATE (:Customer {id:r.id, name:r.name, country:r.country})',
      *rows() {
        const r = seeded(1);
        for (let i = 0; i < c.customers; i++)
          yield { id: id.customer(i), name: `${pick(r, FIRST)} ${pick(r, LAST)}`, country: pick(r, COUNTRIES) };
      },
    },
    {
      name: 'Account+OWNS',
      cypher:
        'UNWIND $rows AS r MATCH (c:Customer {id:r.owner}) CREATE (c)-[:OWNS]->(:Account {id:r.id, type:r.type, opened:r.opened})',
      *rows() {
        const r = seeded(2);
        const start = Date.UTC(2018, 0, 1);
        for (let i = 0; i < c.accounts; i++) {
          // Every customer owns at least one account; the rest go to random customers.
          const owner = i < c.customers ? i : Math.floor(r() * c.customers);
          yield {
            id: id.account(i),
            owner: id.customer(owner),
            type: r() < 0.88 ? 'checking' : 'savings',
            opened: isoDate(start + Math.floor(r() * ((END - start) / DAY)) * DAY),
          };
        }
      },
    },
    {
      name: 'Device',
      cypher: 'UNWIND $rows AS r CREATE (:Device {id:r.id, os:r.os})',
      *rows() {
        const r = seeded(3);
        for (let i = 0; i < c.devices; i++) yield { id: id.device(i), os: pick(r, OS) };
        for (let i = 0; i < inj.rings.length; i++) yield { id: inj.ringDevice(i), os: pick(r, OS) };
      },
    },
    {
      name: 'USES',
      cypher: 'UNWIND $rows AS r MATCH (c:Customer {id:r.c}), (d:Device {id:r.d}) CREATE (c)-[:USES]->(d)',
      *rows() {
        const r = seeded(4);
        for (let i = 0; i < c.customers; i++) {
          const d = i < c.devices ? i : skew(r, c.devices, 1.3);
          yield { c: id.customer(i), d: id.device(d) };
          const d2 = skew(r, c.devices, 1.3);
          if (r() < 0.07 && d2 !== d) yield { c: id.customer(i), d: id.device(d2) };
        }
        for (let i = 0; i < inj.rings.length; i++)
          for (const m of inj.rings[i]) yield { c: id.customer(m), d: inj.ringDevice(i) };
      },
    },
    {
      name: 'Merchant',
      cypher: 'UNWIND $rows AS r CREATE (:Merchant {id:r.id, name:r.name, category:r.category, country:r.country})',
      *rows() {
        const r = seeded(5);
        for (let i = 0; i < c.merchants; i++)
          yield {
            id: id.merchant(i),
            name: `${pick(r, M_ADJ)} ${pick(r, M_NOUN)}`,
            category: pick(r, CATEGORIES),
            country: pick(r, COUNTRIES),
          };
      },
    },
    {
      name: 'Transaction+SENT+RECEIVED_BY',
      // `kind` picks the receiver label; RECEIVED_BY points at Account or Merchant, as in dataset.cypher.
      cypher: `UNWIND $rows AS r MATCH (a:Account {id:r.from})
        CREATE (a)-[:SENT]->(t:Transaction {id:r.id, amount:r.amount, date:r.date})
        WITH t, r
        OPTIONAL MATCH (ba:Account {id:r.to}) WHERE r.kind = 'Account'
        OPTIONAL MATCH (bm:Merchant {id:r.to}) WHERE r.kind = 'Merchant'
        WITH t, coalesce(ba, bm) AS b
        CREATE (t)-[:RECEIVED_BY]->(b)`,
      *rows() {
        const r = seeded(6);
        for (let i = 0; i < c.transactions; i++) {
          const from = skew(r, c.accounts, 1.5);
          let to: number | null = null;
          if (r() < 0.5) {
            to = skew(r, c.accounts, 1.5);
            if (to === from) to = (from + 1) % c.accounts;
          }
          yield txRow(r, i, from, to);
        }
        let i = c.transactions;
        for (const cyc of inj.cycles)
          for (let k = 0; k < cyc.length; k++) yield txRow(r, i++, cyc[k], cyc[(k + 1) % cyc.length]);
      },
    },
  ];
}

function* chunks<T>(it: Iterable<T>, n: number): Generator<T[]> {
  let buf: T[] = [];
  for (const x of it) {
    buf.push(x);
    if (buf.length === n) {
      yield buf;
      buf = [];
    }
  }
  if (buf.length) yield buf;
}

export async function clear(engine: Engine) {
  // Batched so a multi-million-node graph never has to fit in one transaction. Relationships go first:
  // a DETACH DELETE batch that hits hub nodes would otherwise drag in all of their relationships.
  for (const q of [
    'MATCH ()-[r]->() WITH r LIMIT 10000 DELETE r RETURN count(*) AS c',
    'MATCH (n) WITH n LIMIT 10000 DELETE n RETURN count(*) AS c',
  ]) {
    while (Number((await engine.run(q))[0].c) > 0);
  }
}

export type LoadStat = { stream: string; rows: number; seconds: number; rowsPerSec: number };

export async function load(engine: Engine, tier: Tier): Promise<LoadStat[]> {
  const scale = scaleOf(tier);
  await clear(engine);
  for (const q of engine.ddl) {
    try {
      await engine.run(q, {}, { autoCommit: true });
    } catch (e) {
      if (!/exist/i.test(String(e))) throw e; // re-running DDL is fine
    }
  }

  // In-memory engines: learn MiB per scale unit at tier M, refuse a tier L that would not fit.
  const memFile = `results/${engine.name}-mem-per-scale.json`;
  let memBefore = 0;
  if (engine.inMemory && engine.memory) {
    await engine.settle?.();
    const mem = await engine.memory();
    memBefore = mem.used;
    if (tier === 'L' && existsSync(memFile)) {
      const perScale = JSON.parse(readFileSync(memFile, 'utf8')).mibPerScale as number;
      const estimate = memBefore + perScale * scale;
      const budget = mem.limit * config.memHeadroom;
      if (estimate > budget) {
        const max = Math.floor((budget - memBefore) / perScale);
        throw new Error(
          `tier L would use ~${Math.round(estimate)} MiB of ${engine.name}'s ${Math.round(mem.limit)} MiB ` +
            `(headroom ${config.memHeadroom}). Set BENCH_SCALE_L=${max} (the same for every engine).`,
        );
      }
    }
  }

  const stats: LoadStat[] = [];
  if (tier === 'S') {
    const text = readFileSync('dataset.cypher', 'utf8').replace(/^\/\/.*$/gm, '');
    const t0 = performance.now();
    const statements = text
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const s of statements) await engine.run(s);
    const seconds = (performance.now() - t0) / 1000;
    stats.push({ stream: 'dataset.cypher', rows: statements.length, seconds, rowsPerSec: statements.length / seconds });
  } else {
    for (const s of streams(scale)) {
      const t0 = performance.now();
      let rows = 0;
      for (const batch of chunks(s.rows(), config.batchSize)) {
        await engine.run(s.cypher, { rows: batch });
        rows += batch.length;
      }
      const seconds = (performance.now() - t0) / 1000;
      stats.push({ stream: s.name, rows, seconds, rowsPerSec: rows / seconds });
      log(`  ${s.name}: ${rows} rows in ${seconds.toFixed(1)}s (${Math.round(rows / seconds)} rows/s)`);
    }
  }

  if (engine.inMemory && engine.memory && tier === 'M') {
    const used = (await engine.memory()).used;
    mkdirSync('results', { recursive: true });
    writeFileSync(memFile, JSON.stringify({ mibPerScale: (used - memBefore) / scale }));
  }
  return stats;
}
