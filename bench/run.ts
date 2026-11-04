// Benchmark runner: pnpm bench <phase> --db <engine> [--tier S|M|L]
// Every run writes results/<db>-<phase>-<tier>-<time>.{csv,log}, plus .container.log if something fails.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { config, type Tier } from './config.ts';
import { ALGOS, type AlgoName, type Row } from './engines/engine.ts';
import { ENGINES } from './engines/index.ts';
import { counts, ids, injected, load, rng, scaleOf } from './gen.ts';
import { closeLog, describeError, firstLine, log, logOnce, openLog, trace } from './log.ts';
import {
  byName,
  CLEANUP,
  context,
  cypherFor,
  HEAVY,
  MIXES,
  type Mix,
  picker,
  WORKLOADS,
  type Workload,
} from './queries.ts';

const PHASES = ['load', 'validate', 'baseline', 'stress', 'soak', 'algo', 'capacity', 'coldstart'] as const;
type Phase = (typeof PHASES)[number];

const [phaseArg, ...rest] = process.argv.slice(2);
const arg = (k: string) => {
  const i = rest.indexOf(`--${k}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const phase = phaseArg as Phase;
const db = arg('db') ?? '';
const tier = (arg('tier') ?? 'S') as Tier;
const names = Object.keys(ENGINES);
if (!PHASES.includes(phase) || !names.includes(db) || !['S', 'M', 'L'].includes(tier)) {
  console.error(`usage: pnpm bench <${PHASES.join('|')}> --db <${names.join('|')}> [--tier S|M|L]`);
  process.exit(2);
}
const unknown = config.engines.filter((n) => !names.includes(n));
if (unknown.length) {
  console.error(`BENCH_ENGINES has unregistered engines: ${unknown.join(', ')} (known: ${names.join(', ')})`);
  process.exit(2);
}
const skipLoad = process.env.BENCH_SKIP_LOAD === '1'; // reuse already-loaded data while iterating

mkdirSync('results', { recursive: true });
const base = `results/${db}-${phase}-${tier}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
const csv = `${base}.csv`;
const containerLog = `${base}.container.log`;
openLog(`${base}.log`);

const sh = promisify(execFile);
const engine = ENGINES[db](Math.max(256, ...config.concurrency, ...config.heavyConcurrency));

async function exec(w: Workload, params: Row): Promise<Row[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await engine.run(cypherFor(w, engine), params, {
        write: w.type === 'write',
        timeoutMs: config.queryTimeoutSec * 1000,
      });
    } catch (e) {
      // Same policy for every engine: retry conflicts and deadlocks with jittered backoff, never timeouts.
      if (!engine.retriable(e) || attempt >= config.maxRetries) throw e;
      rec.retry(w.name);
      await sleep(Math.min(1000, 5 * 2 ** attempt) * (0.5 + Math.random()));
    }
  }
}

// ---------- metrics ----------
type Bucket = { lat: number[]; err: number; retries: number };
type Stat = {
  op: string;
  count: number;
  errors: number;
  retries?: number;
  tput: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};
const empty = (): Bucket => ({ lat: [], err: 0, retries: 0 });

function summarize(op: string, b: Bucket, seconds: number): Stat {
  const lat = b.lat.sort((a, z) => a - z);
  const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : NaN);
  return {
    op,
    count: lat.length,
    errors: b.err,
    retries: b.retries,
    tput: lat.length / seconds,
    p50: q(0.5),
    p95: q(0.95),
    p99: q(0.99),
    max: lat.length ? lat[lat.length - 1] : NaN,
  };
}

class Recorder {
  window = new Map<string, Bucket>();
  step = new Map<string, Bucket>();
  measuring = true;
  windowStart = performance.now();
  stepStart = performance.now();
  errors = new Map<string, number>();

  private buckets(op: string) {
    const out: Bucket[] = [];
    for (const m of this.measuring ? [this.window, this.step] : [this.window]) {
      for (const key of [op, 'ALL']) {
        const b = m.get(key) ?? empty();
        m.set(key, b);
        out.push(b);
      }
    }
    return out;
  }
  retry(op: string) {
    for (const b of this.buckets(op)) b.retries++;
  }
  add(op: string, ms: number, ok: boolean, err?: unknown) {
    for (const b of this.buckets(op)) {
      if (ok) b.lat.push(ms);
      else b.err++;
    }
    if (!ok) {
      const k = `${op}: ${firstLine(err).slice(0, 140)}`;
      this.errors.set(k, (this.errors.get(k) ?? 0) + 1);
    }
  }
  private take(m: Map<string, Bucket>, since: number): Stat[] {
    const seconds = (performance.now() - since) / 1000;
    const out = [...m].map(([op, b]) => summarize(op, b, seconds)).sort((a, b) => a.op.localeCompare(b.op));
    m.clear();
    return out;
  }
  takeWindow() {
    const s = this.take(this.window, this.windowStart);
    this.windowStart = performance.now();
    return s;
  }
  beginStep() {
    this.step.clear();
    this.measuring = true;
    this.stepStart = performance.now();
  }
  takeStep() {
    return this.take(this.step, this.stepStart);
  }
}

const rec = new Recorder();
const errPct = (s: Stat) => (100 * s.errors) / Math.max(1, s.count + s.errors);
const allOf = (stats: Stat[]) => stats.find((s) => s.op === 'ALL') ?? summarize('ALL', empty(), 1);
const blank = { tput: NaN, p50: NaN, p95: NaN, p99: NaN, max: NaN };

// ---------- container ----------
let cid = '';
const toMiB = (s: string) => {
  const m = s.match(/([\d.]+)\s*([KMGT]?i?B)/);
  const unit: Record<string, number> = { B: 2 ** -20, KiB: 2 ** -10, KB: 2 ** -10, MiB: 1, MB: 1, GiB: 1024, GB: 1024 };
  return m ? Number(m[1]) * (unit[m[2]] ?? NaN) : NaN;
};
type Sample = { cpu: number; mem: number; dbMem: number; store: number };
const warn = (what: string) => (e: unknown) => {
  logOnce(`sampling: ${what} failed: ${firstLine(e)}`, () => describeError(e), 'WARN');
  return undefined;
};
async function sample(): Promise<Sample> {
  const [st, du, dbMem] = await Promise.all([
    sh('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}};{{.MemUsage}}', cid]).then(
      (r) => r.stdout.trim(),
      warn('docker stats'),
    ),
    sh('docker', ['exec', cid, 'du', '-sm', engine.dataDir]).then(
      (r) => Number(r.stdout.split(/\s/)[0]),
      warn('store size (du)'),
    ),
    engine.memory?.().then((m) => m.used, warn(`${db} memory`)),
  ]);
  const [cpu, mem] = (st ?? ';').split(';');
  return { cpu: parseFloat(cpu), mem: toMiB(mem ?? ''), dbMem: dbMem ?? NaN, store: du ?? NaN };
}

const EXIT_HINTS: Record<number, string> = {
  137: 'SIGKILL: OOM killer (host/VM memory or cgroup limit) or `docker kill`',
  139: 'SIGSEGV: the database crashed',
  134: 'SIGABRT: the database aborted (failed assertion or allocation)',
  133: 'SIGTRAP: the database crashed (for Memgraph, check vm.max_map_count in the container log)',
  143: 'SIGTERM: stopped by `docker stop` or the host',
};

// Detects crashes, OOM kills and restarts of the database container between windows.
let lastState = { running: true, startedAt: '' };
let expectRestart = false;
// Set when the container dies; the load loops stop on it instead of erroring for the rest of the run.
let abort: Error | undefined;
async function checkContainer() {
  const r = await sh('docker', ['inspect', '-f', '{{json .State}}', cid]).catch(warn('docker inspect'));
  if (!r) return;
  const st = JSON.parse(r.stdout) as { Running: boolean; StartedAt: string; OOMKilled: boolean; ExitCode: number };
  const changed = st.Running !== lastState.running || (lastState.startedAt && st.StartedAt !== lastState.startedAt);
  if (changed && !expectRestart) {
    log(
      `container ${db} ${st.Running ? 'restarted' : 'stopped'} during "${label}": ` +
        `running=${st.Running} oomKilled=${st.OOMKilled} exitCode=${st.ExitCode} startedAt=${st.StartedAt}` +
        (st.Running ? '' : ` (${EXIT_HINTS[st.ExitCode] ?? 'see the container log'})`),
      'ERROR',
    );
    await saveContainerLogs(`container ${st.Running ? 'restarted' : 'stopped'} during "${label}"`);
    if (!st.Running) abort = new Error(`${db} container stopped (oomKilled=${st.OOMKilled}, exitCode=${st.ExitCode})`);
  }
  lastState = { running: st.Running, startedAt: st.StartedAt };
  return st;
}

let savedContainerLogs = false;
async function saveContainerLogs(reason: string) {
  if (!cid || savedContainerLogs) return;
  savedContainerLogs = true;
  const out = await new Promise<string>((resolve) =>
    execFile('docker', ['logs', '--tail', '300', '--timestamps', cid], { maxBuffer: 64 * 2 ** 20 }, (e, so, se) =>
      resolve(e && !so && !se ? `docker logs failed: ${describeError(e)}` : `${so}${se}`),
    ),
  );
  appendFileSync(containerLog, `===== ${new Date().toISOString()} ${reason}: last 300 lines of ${db} =====\n${out}\n`);
  log(`saved the container's last 300 log lines to ${containerLog}`, 'ERROR');
}

// ---------- CSV ----------
const COLS = [
  'kind',
  'label',
  't_s',
  'op',
  'count',
  'errors',
  'retries',
  'tput',
  'p50_ms',
  'p95_ms',
  'p99_ms',
  'max_ms',
  'cpu_pct',
  'mem_mib',
  'db_mem_mib',
  'store_mib',
];
const fmt = (v: unknown) =>
  typeof v === 'number'
    ? Number.isFinite(v)
      ? String(Math.round(v * 100) / 100)
      : ''
    : `"${String(v ?? '').replace(/"/g, '""')}"`;
const runStart = performance.now();
const elapsed = () => (performance.now() - runStart) / 1000;
let label: string = phase;
const windows: Array<{ t: number; label: string; all: Stat; s: Sample }> = [];

function row(kind: string, s: Stat, smp?: Sample) {
  const cells = [kind, label, elapsed(), s.op, s.count, s.errors, s.retries, s.tput, s.p50, s.p95, s.p99, s.max];
  appendFileSync(csv, `${[...cells, smp?.cpu, smp?.mem, smp?.dbMem, smp?.store].map(fmt).join(',')}\n`);
}

// Rolling windows for the whole run (soak drift/leak detection, spike recovery) + a heartbeat in the log.
let ticker: NodeJS.Timeout | undefined;
let sampling = false;
function startTicker() {
  ticker = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const stats = rec.takeWindow();
      const [s] = await Promise.all([sample(), checkContainer()]);
      for (const st of stats) row('window', st, s);
      const all = allOf(stats);
      windows.push({ t: elapsed(), label, all, s });
      trace(
        `[${label}] t=${elapsed().toFixed(0)}s ops/s=${all.tput.toFixed(1)} p99=${all.p99.toFixed(1)}ms ` +
          `errors=${all.errors} retries=${all.retries} cpu=${s.cpu}% mem=${s.mem.toFixed(0)}MiB store=${s.store}MiB`,
      );
    } catch (e) {
      logOnce(`sampling window failed: ${firstLine(e)}`, () => describeError(e), 'WARN');
    } finally {
      sampling = false;
    }
  }, config.sampleSec * 1000);
}

// ---------- load generators ----------
const preview = (v: unknown) => {
  const s = JSON.stringify(v);
  return s.length > 500 ? `${s.slice(0, 500)}... (${s.length} chars)` : s;
};

async function runOp(w: Workload, params: Row, startedAt: number) {
  try {
    await exec(w, params);
    rec.add(w.name, performance.now() - startedAt, true);
  } catch (e) {
    rec.add(w.name, performance.now() - startedAt, false, e);
    logOnce(
      `query error ${w.name}: ${firstLine(e)}`,
      () => `step: ${label}\nparams: ${preview(params)}\n${describeError(e)}`,
    );
  }
}

// Closed loop: N clients, each sends its next query when the previous one returns.
async function closedLoop(m: Mix, clients: number, seconds: number) {
  const next = picker(m);
  const end = performance.now() + seconds * 1000;
  await Promise.all(
    Array.from({ length: clients }, async (_, k) => {
      const r = rng(config.seed + 1 + k);
      const x = context(tier, r, `c${k}`);
      while (performance.now() < end) {
        if (abort) throw abort;
        const w = next(r);
        const p = w.params(x);
        if (p) await runOp(w, p, performance.now());
      }
    }),
  );
}

// Open loop: requests are sent on a fixed schedule whatever the latency; latency counts from the
// scheduled time, so a stalled server shows up as latency instead of being hidden (coordinated omission).
async function openLoop(m: Mix, rate: (tSec: number) => number, seconds: number) {
  const next = picker(m);
  const r = rng(config.seed + 999);
  const x = context(tier, r, 'o');
  const start = performance.now();
  const end = start + seconds * 1000;
  const inFlight = new Set<Promise<void>>();
  let due = start;
  while (due < end) {
    if (abort) throw abort;
    const now = performance.now();
    while (due <= now && due < end) {
      const w = next(r);
      const p = w.params(x);
      if (p) {
        if (inFlight.size >= config.maxInFlight) {
          rec.add(w.name, now - due, false, new Error('client: too many requests in flight'));
          logOnce('client shedding load: BENCH_MAX_IN_FLIGHT reached', () => `step: ${label}`, 'WARN');
        } else {
          const pr = runOp(w, p, due);
          inFlight.add(pr);
          pr.finally(() => inFlight.delete(pr));
        }
      }
      due += 1000 / rate((due - start) / 1000);
    }
    await sleep(Math.max(1, due - performance.now()));
  }
  await Promise.all(inFlight);
}

// Writes from a step would otherwise pile up and change the graph for every later step.
async function removeCreated() {
  while (Number((await engine.run(CLEANUP))[0].c) > 0);
}

async function measuredStep(stepLabel: string, warmup: () => Promise<void>, run: () => Promise<void>) {
  label = stepLabel;
  trace(`step start: ${stepLabel}`);
  rec.measuring = false;
  await warmup();
  rec.beginStep();
  await run();
  const stats = rec.takeStep();
  for (const s of stats) row('step', s);
  await removeCreated();
  const all = allOf(stats);
  log(
    `  ${stepLabel}: ${all.tput.toFixed(1)} ops/s  p50 ${all.p50.toFixed(1)}ms  p99 ${all.p99.toFixed(1)}ms  ` +
      `errors ${all.errors}  retries ${all.retries}`,
  );
  return stats;
}

// ---------- phases ----------
async function loadPhase() {
  label = 'load';
  log(`loading tier ${tier} (scale ${scaleOf(tier)})...`);
  for (const s of await load(engine, tier)) {
    row('load', { ...blank, op: s.stream, count: s.rows, errors: 0, tput: s.rowsPerSec, max: s.seconds * 1000 });
  }
}

const canon = (v: unknown): unknown => {
  if (typeof v === 'number') return Number(v.toPrecision(9)); // absorbs float summation-order differences
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .sort()
        .map(([k, x]) => [k, canon(x)]),
    );
  }
  return v;
};

async function validate() {
  const out: Record<string, unknown> = {};
  const nodes = await engine.run('MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY label');
  const rels = await engine.run('MATCH ()-[r]->() RETURN type(r) AS type, count(*) AS n ORDER BY type');
  out.nodes = Object.fromEntries(nodes.map((r) => [r.label, r.n]));
  out.rels = Object.fromEntries(rels.map((r) => [r.type, r.n]));
  log(`nodes ${JSON.stringify(out.nodes)} rels ${JSON.stringify(out.rels)}`);

  const reads = WORKLOADS.filter((w) => w.type === 'read');
  for (const w of reads) {
    const x = context(tier, rng(config.seed + 7), 'v'); // the same parameters on every engine
    const hash = createHash('sha256');
    let n = 0;
    for (let i = 0; i < 20; i++) {
      const rows = await exec(w, w.params(x) ?? {});
      n += rows.length;
      for (const line of rows.map((r) => JSON.stringify(canon(r))).sort()) hash.update(`${line}\n`);
    }
    out[w.name] = { rows: n, hash: hash.digest('hex').slice(0, 16) };
    log(`  ${w.name}: ${n} rows`);
  }

  if (tier !== 'S') {
    const inj = injected(scaleOf(tier));
    const id = ids(counts(scaleOf(tier)));
    const ring = inj.rings[0];
    const ringRows = (await exec(byName('R5'), { id: id.customer(ring[0]) })).filter(
      (r) => r.device === inj.ringDevice(0),
    ).length;
    const cycles = Number((await exec(byName('R9'), { id: id.account(inj.cycles[0][0]) }))[0].cycles);
    out.injected = { ringMembersFound: ringRows, ringMembersExpected: ring.length - 1, cycleFound: cycles >= 1 };
    log(`  injected patterns ${JSON.stringify(out.injected)}`);
  }

  for (const a of ALGOS) {
    out[a] = await engine.algo(a).then(
      (r) => canon(r.rows),
      (e) => {
        log(`${a} failed: ${describeError(e)}`, 'ERROR');
        return `ERROR ${firstLine(e)}`;
      },
    );
    log(`  ${a}: ${JSON.stringify(out[a])}`);
  }

  const file = (n: string) => `results/validate-${n}-${tier}.json`;
  writeFileSync(file(db), JSON.stringify(out, null, 2));
  let bad = 0;
  for (const other of config.engines.filter((n) => n !== db)) {
    if (!existsSync(file(other))) {
      log(`run validate on ${other} to compare (${file(other)} missing)`);
      continue;
    }
    const them = JSON.parse(readFileSync(file(other), 'utf8'));
    log(`compared with ${other}:`);
    const check = (name: string, ok: boolean, note = '') => {
      log(`${ok ? 'OK      ' : 'MISMATCH'} ${name} ${note}`, ok ? 'INFO' : 'ERROR');
      if (!ok) bad++;
    };
    const same = (k: string) => JSON.stringify(out[k]) === JSON.stringify(them[k]);
    for (const k of ['nodes', 'rels', ...reads.map((w) => w.name), 'A2_wcc']) check(k, same(k));
    const top = (o: unknown) => (Array.isArray(o) ? o.map((r) => r.id) : []);
    const overlap = top(out.A1_pagerank).filter((i) => top(them.A1_pagerank).includes(i)).length;
    check('A1_pagerank top-10 overlap', overlap >= 8, `${overlap}/10`);
    log(`info     A3_louvain ${JSON.stringify(out.A3_louvain)} vs ${JSON.stringify(them.A3_louvain)} (heuristic)`);
    if (out.injected) {
      const found = (out.injected as { cycleFound: boolean }).cycleFound;
      check('injected patterns', found && JSON.stringify(out.injected) === JSON.stringify(them.injected));
    }
  }
  if (bad) {
    log(`validation: ${bad} mismatches`, 'ERROR');
    process.exitCode = 1;
  }
}

async function baseline() {
  for (const w of WORKLOADS.filter((w) => w.name !== 'W4_delete_oldest')) {
    const x = context(tier, rng(config.seed + 3), 'b');
    const once = async () => runOp(w, w.params(x) ?? {}, performance.now());
    const warmEnd = performance.now() + config.warmupSec * 1000;
    await measuredStep(
      `baseline ${w.name}`,
      async () => {
        while (performance.now() < warmEnd) await once();
      },
      async () => {
        for (let i = 0; i < config.baselineIters; i++) await once();
      },
    );
  }
}

const kneeFile = (n: string) => `results/knee-${n}-${tier}.json`;

async function stress() {
  const knees: Record<string, { clients: number; tput: number }> = {};
  for (const [mixName, mk] of Object.entries(MIXES)) {
    log(`ramp ${mixName}`);
    let best = { clients: 0, tput: 0 };
    for (const clients of config.concurrency) {
      const reps: Stat[] = [];
      for (let rep = 1; rep <= config.repeats; rep++) {
        const stats = await measuredStep(
          `${mixName} c=${clients} rep=${rep}`,
          () => closedLoop(mk(), clients, config.warmupSec),
          () => closedLoop(mk(), clients, config.stressStepSec),
        );
        reps.push(allOf(stats));
      }
      const med = [...reps].sort((a, b) => a.tput - b.tput)[Math.floor(reps.length / 2)];
      label = `${mixName} c=${clients} median`;
      row('median', med);
      if (med.tput > best.tput) best = { clients, tput: med.tput };
      if (errPct(med) > config.stopErrorPct || med.p99 > config.stopP99Ms) {
        log(`  stop: errors ${errPct(med).toFixed(2)}%, p99 ${med.p99.toFixed(0)}ms`);
        break;
      }
    }
    knees[mixName] = best;
    log(`  knee ${mixName}: ${best.tput.toFixed(1)} ops/s at ${best.clients} clients`);
  }
  writeFileSync(kneeFile(db), JSON.stringify(knees, null, 2));

  log('heavy queries');
  for (const name of HEAVY) {
    for (const clients of config.heavyConcurrency) {
      await measuredStep(
        `heavy ${name} c=${clients}`,
        () => closedLoop([[byName(name), 1]], clients, config.warmupSec),
        () => closedLoop([[byName(name), 1]], clients, config.stressStepSec),
      );
    }
  }

  // Spike on the read-heavy mix: low -> high -> low, then see how long p99 takes to recover.
  const knee = knees['read-heavy'].tput;
  const lo = config.spikeLow * knee;
  const hi = config.spikeHigh * knee;
  const before = config.stressStepSec;
  const after = 2 * config.stressStepSec;
  log(`spike ${lo.toFixed(0)} -> ${hi.toFixed(0)} ops/s for ${config.spikeSec}s`);
  const t0 = elapsed();
  await measuredStep(
    'spike',
    async () => {},
    () =>
      openLoop(
        MIXES['read-heavy'](),
        (t) => (t >= before && t < before + config.spikeSec ? hi : lo),
        before + config.spikeSec + after,
      ),
  );
  const spikeEnd = t0 + before + config.spikeSec;
  const pre = windows.filter((w) => w.t > t0 && w.t <= t0 + before).map((w) => w.all.p99);
  const preP99 = pre.length ? pre.sort((a, b) => a - b)[Math.floor(pre.length / 2)] : NaN;
  const recovered = windows.find((w) => w.t > spikeEnd + config.sampleSec && w.all.p99 <= 1.2 * preP99);
  const recovery = recovered ? recovered.t - spikeEnd : NaN;
  label = 'spike recovery';
  row('spike', { ...blank, op: 'recovery_s', count: 0, errors: 0, p50: preP99, max: recovery });
  const rec_ = Number.isFinite(recovery) ? `${recovery.toFixed(0)}s` : 'not within the run';
  log(`  p99 before spike ${preP99.toFixed(1)}ms, recovered after ${rec_} (window = ${config.sampleSec}s)`);
}

async function soak() {
  let rate = config.soakRate;
  if (rate <= 1) {
    // The same offered load for every engine: a fraction of the lowest soak-mix knee among them.
    const files = config.engines.map(kneeFile);
    const missing = files.filter((f) => !existsSync(f));
    if (missing.length) {
      throw new Error(
        `soak rate is relative to the stress knee, but ${missing.join(', ')} is missing. ` +
          'Run stress on every engine in BENCH_ENGINES, or set BENCH_SOAK_RATE to an absolute ops/s (> 1).',
      );
    }
    const knees = files.map((f) => JSON.parse(readFileSync(f, 'utf8')).soak?.tput as number | undefined);
    if (knees.some((k) => !k)) throw new Error(`no soak-mix knee in ${files.join(', ')}; re-run stress`);
    rate *= Math.min(...(knees as number[]));
  }
  const seconds = config.soakMinutes * 60;
  log(`soak at ${rate.toFixed(1)} ops/s for ${config.soakMinutes} min`);
  const startT = elapsed();
  await measuredStep(
    'soak',
    () => openLoop(MIXES.soak(), () => rate, config.warmupSec),
    () => openLoop(MIXES.soak(), () => rate, seconds),
  );

  // Flags: p99 drift (first vs last hour, or thirds for short runs), memory growth after settling, errors.
  const w = windows.filter((x) => x.t > startT + config.warmupSec);
  if (w.length < 3) return log('soak too short for drift/leak analysis (need >= 3 windows)', 'WARN');
  const span = Math.max(1, Math.min(Math.round(3600 / config.sampleSec), Math.floor(w.length / 3)));
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const firstP99 = median(w.slice(0, span).map((x) => x.all.p99));
  const lastP99 = median(w.slice(-span).map((x) => x.all.p99));
  const drift = (100 * (lastP99 - firstP99)) / firstP99;
  const settled = w.filter((x) => x.t > startT + config.memSettleMin * 60);
  const memWin = (settled.length >= 3 ? settled : w.slice(Math.floor(w.length / 2))).filter((x) =>
    Number.isFinite(x.s.mem),
  );
  const slope = (pts: Array<[number, number]>) => {
    const n = pts.length;
    const mx = pts.reduce((s, p) => s + p[0], 0) / n;
    const my = pts.reduce((s, p) => s + p[1], 0) / n;
    return pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  };
  const memSlope = slope(memWin.map((x) => [x.t / 3600, x.s.mem])); // MiB per hour
  const errors = w.reduce((s, x) => s + x.all.errors, 0);
  label = 'soak flags';
  row('flags', { ...blank, op: 'p99_drift_pct', count: 0, errors, p50: firstP99, p99: lastP99, max: drift });
  row('flags', { ...blank, op: 'mem_slope_mib_per_h', count: 0, errors, max: memSlope });
  const driftFlag = drift > config.driftPct;
  log(
    `  p99 first ${firstP99.toFixed(1)}ms -> last ${lastP99.toFixed(1)}ms (${drift.toFixed(1)}%)${driftFlag ? '  <-- DRIFT' : ''}`,
    driftFlag ? 'WARN' : 'INFO',
  );
  log(
    `  container memory slope ${memSlope.toFixed(1)} MiB/h${memSlope > 0 && settled.length >= 3 ? '  (check for a leak if this stays positive)' : ''}`,
  );
  log(`  errors ${errors}${errors ? '  <-- ERRORS' : ''}`, errors ? 'WARN' : 'INFO');
}

async function algo() {
  for (const a of ALGOS) {
    for (let rep = 1; rep <= config.repeats; rep++) {
      label = `${a} rep=${rep}`;
      let parts: Record<string, number>;
      try {
        ({ parts } = await engine.algo(a as AlgoName));
      } catch (e) {
        rec.add(a, NaN, false, e);
        row('algo', { ...blank, op: `${a}:error`, count: 0, errors: 1 });
        log(`  ${a} rep ${rep} failed: ${describeError(e)}`, 'ERROR');
        continue;
      }
      for (const [part, ms] of Object.entries(parts)) {
        row('algo', { ...blank, op: `${a}:${part}`, count: 1, errors: 0, p50: ms, max: ms });
      }
      const timing = Object.entries(parts).map(([k, v]) => `${k} ${v.toFixed(0)}ms`);
      log(`  ${a} rep ${rep}: ${timing.join(', ')}`);
    }
  }
}

async function capacity() {
  // In-memory engines ingest until their memory limit and record it; the others then go to a multiple of it.
  const capFile = (n: string) => `results/capacity-${n}-${tier}.json`;
  let target = Infinity;
  if (!engine.inMemory) {
    const refs = config.engines.filter((n) => n !== db && existsSync(capFile(n)));
    if (!refs.length) {
      throw new Error(
        `run capacity on an in-memory engine first; none of ${config.engines.map(capFile).join(', ')} exist`,
      );
    }
    target = Math.round(
      Math.max(...refs.map((n) => JSON.parse(readFileSync(capFile(n), 'utf8')).maxNodes)) * config.capacityX,
    );
  }
  let nodes = Number((await engine.run('MATCH (n) RETURN count(n) AS c'))[0].c);
  let nextProbe = nodes + 1_000_000;
  const x = context(tier, rng(config.seed + 5), 'cap');
  const w2 = byName('W2');
  log(`capacity from ${nodes} nodes ${Number.isFinite(target) ? `to ${target}` : `until ${db} hits its memory limit`}`);
  label = 'capacity';
  while (nodes < target) {
    const t0 = performance.now();
    try {
      // Same ingest as W2 (1 Transaction node + 2 relationships per row), but in load-sized batches.
      const rows = Array.from({ length: config.batchSize / 1000 }, () => w2.params(x)?.rows as unknown[]).flat();
      await engine.run(cypherFor(w2, engine), { rows });
      nodes += rows.length;
      rec.add('ingest_batch', performance.now() - t0, true);
    } catch (e) {
      // Expected for an in-memory engine (its memory limit); for the others it is a failure worth reading.
      log(`  stopped at ${nodes} nodes: ${describeError(e)}`, engine.inMemory ? 'INFO' : 'ERROR');
      break;
    }
    if (nodes >= nextProbe) {
      nextProbe += 1_000_000;
      for (const n of ['R1', 'R6']) {
        const q = byName(n);
        const lat: number[] = [];
        for (let i = 0; i < 50; i++) {
          const t = performance.now();
          await exec(q, q.params(x) ?? {});
          lat.push(performance.now() - t);
        }
        label = `capacity nodes=${nodes}`;
        row('capacity', summarize(n, { ...empty(), lat }, lat.reduce((a, b) => a + b, 0) / 1000));
      }
      log(`  ${nodes} nodes, container memory ${(await sample()).mem.toFixed(0)} MiB`);
    }
  }
  if (engine.inMemory) writeFileSync(capFile(db), JSON.stringify({ maxNodes: nodes }));
  log(`capacity ${db}: ${nodes} nodes; removing the ingested data...`);
  await removeCreated(); // don't leave the database at its memory limit for the next phase
}

async function coldstart() {
  label = 'coldstart';
  expectRestart = true;
  await sh('docker', ['compose', 'stop', db]);
  const t0 = performance.now();
  await sh('docker', ['compose', 'start', db]);
  for (;;) {
    try {
      await engine.run('RETURN 1');
      break;
    } catch (e) {
      if (performance.now() - t0 > 600_000) throw new Error(`${db} not ready 10 min after start: ${firstLine(e)}`);
      await sleep(200);
    }
  }
  const readyS = (performance.now() - t0) / 1000;
  await checkContainer();
  expectRestart = false;
  log(`  ready after ${readyS.toFixed(1)}s`);
  row('coldstart', { ...blank, op: 'ready_s', count: 0, errors: 0, max: readyS });
  // First queries after start: in-memory engines have just loaded their snapshot, disk-based ones have cold caches.
  const next = picker(MIXES['read-heavy']().filter(([w]) => w.type === 'read'));
  const r = rng(config.seed + 11);
  const x = context(tier, r, 'cold');
  const lat: number[] = [];
  for (let i = 0; i < config.baselineIters; i++) {
    const w = next(r);
    const t = performance.now();
    await exec(w, w.params(x) ?? {});
    lat.push(performance.now() - t);
  }
  const tenth = Math.max(1, Math.floor(lat.length / 10));
  const first = summarize('first_10pct', { ...empty(), lat: lat.slice(0, tenth) }, 1);
  const last = summarize('last_10pct', { ...empty(), lat: lat.slice(-tenth) }, 1);
  row('coldstart', first);
  row('coldstart', last);
  log(`  first ${tenth} queries p50 ${first.p50.toFixed(1)}ms, last ${tenth} p50 ${last.p50.toFixed(1)}ms`);
}

// ---------- main ----------
let finished = false;
async function finish(status: 'ok' | 'failed' | 'interrupted', err?: unknown) {
  if (finished) return;
  finished = true;
  clearInterval(ticker);
  if (err) log(`FATAL in "${label}" after ${elapsed().toFixed(0)}s: ${describeError(err)}`, 'ERROR');
  if (status !== 'ok') {
    const st = cid ? await checkContainer().catch(() => undefined) : undefined;
    if (st) log(`container ${db}: ${JSON.stringify(st)}`, 'ERROR');
    for (const w of windows.slice(-3)) {
      log(
        `recent window [${w.label}] t=${w.t.toFixed(0)}s ops/s=${w.all.tput.toFixed(1)} errors=${w.all.errors} mem=${w.s.mem.toFixed(0)}MiB`,
        'ERROR',
      );
    }
    await saveContainerLogs(`run ${status} in "${label}"`).catch(() => {});
  }
  if (rec.errors.size) {
    log('errors by query (full details of the first occurrence of each are above in the log):');
    for (const [error, count] of [...rec.errors].sort((a, b) => b[1] - a[1]).slice(0, 15)) log(`  ${count}x ${error}`);
  }
  await engine.close().catch(() => {});
  const line = `RUN FINISHED status=${status} phase=${phase} db=${db} tier=${tier} duration=${elapsed().toFixed(0)}s csv=${csv}`;
  log(line, status === 'ok' ? 'INFO' : 'ERROR');
  closeLog(); // keep this the last line: in-flight queries failing after it are noise
}

process.on('unhandledRejection', (e) => void finish('failed', e).then(() => process.exit(1)));
process.on('uncaughtException', (e) => void finish('failed', e).then(() => process.exit(1)));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log(`received ${sig} in "${label}"`, 'WARN');
    void finish('interrupted').then(() => process.exit(130));
  });
}

try {
  log(`${phase} on ${db}, tier ${tier}: ${csv}`);
  const commit = await sh('git', ['rev-parse', '--short', 'HEAD']).then(
    (r) => r.stdout.trim(),
    () => 'unknown',
  );
  trace(`argv=${JSON.stringify(process.argv.slice(2))} node=${process.version} git=${commit} pid=${process.pid}`);
  log(`config ${JSON.stringify(config)}`);
  cid = (await sh('docker', ['compose', 'ps', '-q', db])).stdout.trim();
  if (!cid) throw new Error(`${db} container is not running: docker compose up -d ${db}`);
  await checkContainer();
  const ins = JSON.parse((await sh('docker', ['inspect', cid])).stdout)[0];
  const server = {
    container: cid.slice(0, 12),
    image: ins.Config.Image,
    cpus: ins.HostConfig.NanoCpus / 1e9,
    memLimitMiB: ins.HostConfig.Memory / 2 ** 20,
    ...(await engine.serverInfo()),
  };
  log(`server ${JSON.stringify(server)}`);
  writeFileSync(
    csv,
    `${[
      `# phase=${phase} db=${db} tier=${tier} scale=${scaleOf(tier)} started=${new Date().toISOString()} git=${commit}`,
      `# config=${JSON.stringify(config)}`,
      `# server=${JSON.stringify(server)}`,
      COLS.join(','),
    ].join('\n')}\n`,
  );
  startTicker();

  if (phase === 'load' || !skipLoad) await loadPhase();
  const phases: Record<Exclude<Phase, 'load'>, () => Promise<void>> = {
    validate,
    baseline,
    stress,
    soak,
    algo,
    capacity,
    coldstart,
  };
  if (phase !== 'load') await phases[phase]();
  await finish(process.exitCode ? 'failed' : 'ok');
} catch (e) {
  await finish('failed', e);
  process.exitCode = 1;
}
