// Generator self-check (no database needed): pnpm test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { counts, ids, injected, streams } from './gen.ts';

test('scale 1 reproduces the counts and id formats of dataset.cypher', () => {
  const c = counts(1);
  assert.deepEqual(c, { customers: 71, accounts: 81, devices: 62, merchants: 13, transactions: 283 });
  const text = readFileSync('dataset.cypher', 'utf8');
  const id = ids(c);
  for (const [fn, n] of [
    [id.customer, 71],
    [id.account, 81],
    [id.device, 62],
    [id.merchant, 13],
    [id.tx, 283],
  ] as const) {
    assert.ok(text.includes(`'${fn(0)}'`) && text.includes(`'${fn(n - 1)}'`), `${fn(0)}..${fn(n - 1)} in dataset`);
  }
});

test('generated tier is deterministic and referentially intact', () => {
  const scale = 20;
  const c = counts(scale);
  const run = () => streams(scale).map((s) => [...s.rows()]);
  const [a, b] = [run(), run()];
  assert.deepEqual(a, b, 'same seed, same data');

  const [customers, accounts, devices, uses, merchants, txs] = a;
  const set = (rows: (typeof a)[number]) => new Set(rows.map((r) => r.id));
  const C = set(customers),
    A = set(accounts),
    D = set(devices),
    M = set(merchants);
  assert.equal(C.size, c.customers);
  assert.equal(A.size, c.accounts);
  assert.equal(M.size, c.merchants);
  assert.equal(set(txs).size, txs.length, 'transaction ids unique');
  for (const r of accounts) assert.ok(C.has(r.owner as string));
  for (const r of uses) assert.ok(C.has(r.c as string) && D.has(r.d as string));
  for (const r of txs) {
    assert.ok(A.has(r.from as string));
    assert.ok((r.kind === 'Account' ? A : M).has(r.to as string), `${r.kind} ${r.to}`);
    assert.ok((r.amount as number) >= 6 && (r.amount as number) <= 13150);
    assert.match(r.date as string, /^20(25|26)-\d\d-\d\d$/);
  }
  const owned = new Set(accounts.map((r) => r.owner));
  assert.equal(owned.size, c.customers, 'every customer owns an account');

  // Hubs exist: the busiest merchant receives far more than an even share.
  const perMerchant = new Map<unknown, number>();
  for (const r of txs) if (r.kind === 'Merchant') perMerchant.set(r.to, (perMerchant.get(r.to) ?? 0) + 1);
  const toMerchants = [...perMerchant.values()].reduce((s, n) => s + n, 0);
  assert.ok(Math.max(...perMerchant.values()) > 3 * (toMerchants / c.merchants), 'merchant hub');
});

test('injected rings and cycles are present in the generated rows', () => {
  const scale = 200;
  const inj = injected(scale);
  const id = ids(counts(scale));
  assert.ok(inj.rings.length > 0 && inj.cycles.length > 0);
  for (const ring of inj.rings) assert.ok(ring.length >= 3 && ring.length <= 8 && new Set(ring).size === ring.length);
  for (const cyc of inj.cycles) assert.ok(cyc.length >= 3 && cyc.length <= 5 && new Set(cyc).size === cyc.length);

  const all = streams(scale);
  const uses = [...all[3].rows()];
  const ring0 = new Set(uses.filter((r) => r.d === inj.ringDevice(0)).map((r) => r.c));
  assert.deepEqual(ring0, new Set(inj.rings[0].map(id.customer)));
  const edges = new Set([...all[5].rows()].map((r) => `${r.from}>${r.to}`));
  const cyc = inj.cycles[0].map(id.account);
  for (const [k, acc] of cyc.entries()) assert.ok(edges.has(`${acc}>${cyc[(k + 1) % cyc.length]}`), 'cycle edge');
});

test('a malformed BENCH_* value fails instead of falling back to the default', () => {
  const load = (env: Record<string, string>) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./bench/config.ts')"], {
      env: { ...process.env, ...env },
      stdio: 'pipe',
    });
  assert.throws(() => load({ BENCH_SOAK_MINUTES: 'abc' }), /BENCH_SOAK_MINUTES=abc is not a number/);
  assert.throws(() => load({ BENCH_SPIKE: '1,2' }), /BENCH_SPIKE/);
  assert.doesNotThrow(() => load({ BENCH_SOAK_MINUTES: '3' }));
});
