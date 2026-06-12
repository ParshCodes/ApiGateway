/**
 * Self-contained benchmark: starts backends + gateway, runs autocannon,
 * prints results, then shuts everything down.
 */
const { spawn } = require('child_process');
const autocannon = require('autocannon');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const BACKENDS_DIR = path.join(ROOT, 'backends');
const GATEWAY_DIR  = path.join(ROOT, 'gateway');

const procs = [];

function start(dir, env, label) {
  const p = spawn('node', ['dist/server.js'], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', d => process.stdout.write(`[${label}] ${d}`));
  p.stderr.on('data', d => {});
  procs.push(p);
  return p;
}

function startGateway(env) {
  const p = spawn('node', ['dist/index.js'], {
    cwd: GATEWAY_DIR,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', d => process.stdout.write(`[gateway] ${d}`));
  p.stderr.on('data', d => {});
  procs.push(p);
  return p;
}

function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

function bench(url, connections, duration) {
  return new Promise((resolve, reject) => {
    autocannon({ url, connections, duration, pipelining: 1 }, (err, res) => {
      if (err) reject(err); else resolve(res);
    });
  });
}

function shutdown() {
  procs.forEach(p => { try { p.kill('SIGTERM'); } catch (_) {} });
}

const p = (v, n) => String(v).padStart(n);
const pL = (v, n) => String(v).padEnd(n);

async function main() {
  console.log('\n┌─────────────────────────────────────────────────────┐');
  console.log('│            API Gateway Benchmark Suite              │');
  console.log('└─────────────────────────────────────────────────────┘\n');

  // --- Start backends ---
  start(BACKENDS_DIR, { PORT: '3001', INSTANCE_ID: 'backend-1', MIN_LATENCY:'10', MAX_LATENCY:'100' }, 'b1');
  start(BACKENDS_DIR, { PORT: '3002', INSTANCE_ID: 'backend-2', MIN_LATENCY:'10', MAX_LATENCY:'150' }, 'b2');
  start(BACKENDS_DIR, { PORT: '3003', INSTANCE_ID: 'backend-3', MIN_LATENCY:'20', MAX_LATENCY:'80'  }, 'b3');

  console.log('Starting backends...');
  await waitMs(6000);

  // --- Start gateway ---
  startGateway({
    PORT: '3000',
    RATE_LIMIT_ENABLED: 'false',
    BACKENDS: 'http://localhost:3001,http://localhost:3002,http://localhost:3003',
    LB_STRATEGY: 'round-robin',
  });

  console.log('Starting gateway...');
  await waitMs(6000);
  console.log('All services up.\n');

  // ──────────────────────────────────────────────────────────────────────
  // GROUP 1: gateway with 3 backends
  // ──────────────────────────────────────────────────────────────────────
  console.log('▶  Group 1: Gateway → 3 backends (round-robin)\n');
  const GW = 'http://localhost:3000/bench';
  const g1 = [];
  for (const [label, conns, dur] of [
    ['50 RPS',    5,  10],
    ['200 RPS',  20,  12],
    ['500 RPS',  50,  12],
    ['1000 RPS', 100, 15],
  ]) {
    process.stdout.write(`  ${pL(label,10)}`);
    const r = await bench(GW, conns, dur);
    process.stdout.write(`rps=${p(Math.round(r.requests.mean),5)}  p50=${p(r.latency.p50,4)}ms  p97.5=${p(r.latency.p97_5,4)}ms  p99=${p(r.latency.p99,4)}ms  err=${r.errors}\n`);
    g1.push({ label, r });
  }

  // ──────────────────────────────────────────────────────────────────────
  // GROUP 2: single backend direct (no gateway overhead)
  // ──────────────────────────────────────────────────────────────────────
  console.log('\n▶  Group 2: Direct → backend-1 only (1 backend, no gateway)\n');
  const B1 = 'http://localhost:3001/bench';
  const g2 = [];
  for (const [label, conns, dur] of [
    ['50 RPS',   5,  10],
    ['200 RPS', 20,  12],
    ['500 RPS', 50,  12],
  ]) {
    process.stdout.write(`  ${pL(label,10)}`);
    const r = await bench(B1, conns, dur);
    process.stdout.write(`rps=${p(Math.round(r.requests.mean),5)}  p50=${p(r.latency.p50,4)}ms  p97.5=${p(r.latency.p97_5,4)}ms  p99=${p(r.latency.p99,4)}ms  err=${r.errors}\n`);
    g2.push({ label, r });
  }

  // ──────────────────────────────────────────────────────────────────────
  // Print formatted tables
  // ──────────────────────────────────────────────────────────────────────
  const SEP = '─'.repeat(78);

  function printTable(title, rows) {
    console.log('\n' + title);
    console.log(SEP);
    console.log(pL('Scenario',12)+p('Act RPS',9)+p('p50 ms',9)+p('p97.5 ms',11)+p('p99 ms',9)+p('Errors',9)+p('Timeouts',11));
    console.log(SEP);
    for (const { label, r } of rows) {
      console.log(pL(label,12)+p(Math.round(r.requests.mean),9)+p(r.latency.p50,9)+p(r.latency.p97_5,11)+p(r.latency.p99,9)+p(r.errors,9)+p(r.timeouts,11));
    }
    console.log(SEP);
  }

  printTable('Group 1 — Gateway · 3 backends · no rate limiting', g1);
  printTable('Group 2 — Single backend direct (scaling comparison)', g2);

  // Scaling summary
  const m1 = Object.fromEntries(g1.map(x => [x.label, x.r]));
  const m2 = Object.fromEntries(g2.map(x => [x.label, x.r]));
  console.log('\nScaling Impact — 3-backend gateway vs single backend');
  console.log(SEP);
  console.log(pL('Scenario',12)+pL('Stack',26)+p('RPS',7)+p('p50 ms',9)+p('p99 ms',9));
  console.log(SEP);
  for (const lbl of ['50 RPS','200 RPS','500 RPS']) {
    if (m1[lbl]) console.log(pL(lbl,12)+pL('Gateway (3 backends)',26)+p(Math.round(m1[lbl].requests.mean),7)+p(m1[lbl].latency.p50,9)+p(m1[lbl].latency.p99,9));
    if (m2[lbl]) console.log(pL('',12)  +pL('Single backend',26)      +p(Math.round(m2[lbl].requests.mean),7)+p(m2[lbl].latency.p50,9)+p(m2[lbl].latency.p99,9));
    console.log('');
  }
  console.log(SEP);

  // Machine-readable for copy-paste into README
  const allData = { g1: g1.map(x=>({label:x.label,rps:Math.round(x.r.requests.mean),p50:x.r.latency.p50,p975:x.r.latency.p97_5,p99:x.r.latency.p99,errors:x.r.errors,timeouts:x.r.timeouts})), g2: g2.map(x=>({label:x.label,rps:Math.round(x.r.requests.mean),p50:x.r.latency.p50,p975:x.r.latency.p97_5,p99:x.r.latency.p99,errors:x.r.errors,timeouts:x.r.timeouts})) };
  console.log('\nRAW_JSON_START');
  console.log(JSON.stringify(allData));
  console.log('RAW_JSON_END');

  shutdown();
  process.exit(0);
}

main().catch(e => { console.error(e); shutdown(); process.exit(1); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });
