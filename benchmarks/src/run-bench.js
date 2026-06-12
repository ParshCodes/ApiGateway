// Plain JS runner so we don't need ts-node for the benchmark itself
const autocannon = require('autocannon');

const URL = 'http://localhost:3000/bench';

async function run(label, connections, duration) {
  return new Promise((resolve, reject) => {
    const inst = autocannon({ url: URL, connections, duration, pipelining: 1 }, (err, res) => {
      if (err) return reject(err);
      resolve({ label, res });
    });
  });
}

const pad = (v, n) => String(v).padStart(n);
const padL = (v, n) => String(v).padEnd(n);

function table(title, rows) {
  const SEP = '─'.repeat(82);
  console.log('\n' + title);
  console.log(SEP);
  console.log(padL('Scenario', 12) + pad('Act RPS', 10) + pad('p50 ms', 9) + pad('p97.5 ms', 11) + pad('p99 ms', 9) + pad('Errors', 9) + pad('Timeouts', 11));
  console.log(SEP);
  for (const r of rows) {
    const l = r.res.latency;
    const q = r.res.requests;
    console.log(
      padL(r.label, 12) +
      pad(Math.round(q.mean), 10) +
      pad(l.p50, 9) +
      pad(l.p97_5, 11) +
      pad(l.p99, 9) +
      pad(r.res.errors, 9) +
      pad(r.res.timeouts, 11)
    );
  }
  console.log(SEP);
}

async function main() {
  console.log('\n=== API Gateway Benchmark ===');
  console.log('Target:', URL, '\n');

  // Group 1: 3 backends, no rate limiting
  console.log('[1/3] Baseline — 3 backends, no rate limiting');
  const g1 = [];
  for (const [label, conns, dur] of [
    ['50 RPS',   5,  10],
    ['200 RPS',  20, 12],
    ['500 RPS',  50, 12],
    ['1000 RPS', 100,15],
  ]) {
    process.stdout.write(`  running ${label}...`);
    const r = await run(label, conns, dur);
    process.stdout.write(` done (${Math.round(r.res.requests.mean)} rps)\n`);
    g1.push(r);
  }
  table('Group 1 — 3 backends · no rate limiting', g1);

  // Group 2: only 1 backend (scaling comparison)
  // We simulate by routing only to backend-1 via a second gateway, but since
  // we have one gateway we test directly against backend1 on :3001
  console.log('\n[2/3] Single-backend scaling comparison (direct to backend-1 :3001)');
  const g2url = 'http://localhost:3001/bench';
  const g2 = [];
  for (const [label, conns, dur] of [
    ['50 RPS',   5,  10],
    ['200 RPS',  20, 12],
    ['500 RPS',  50, 12],
  ]) {
    process.stdout.write(`  running ${label}...`);
    const r = await new Promise((resolve, reject) => {
      autocannon({ url: g2url, connections: conns, duration: dur, pipelining: 1 }, (err, res) => {
        if (err) return reject(err);
        resolve({ label, res });
      });
    });
    process.stdout.write(` done (${Math.round(r.res.requests.mean)} rps)\n`);
    g2.push(r);
  }
  table('Group 2 — 1 backend direct · no gateway overhead', g2);

  // Summary table comparing gateway vs single backend
  console.log('\n=== Scaling Impact (via gateway 3-backend vs single backend) ===');
  const map1 = Object.fromEntries(g1.map(r => [r.label, r.res]));
  const map2 = Object.fromEntries(g2.map(r => [r.label, r.res]));
  const SEP = '─'.repeat(72);
  console.log(SEP);
  console.log(padL('Scenario', 12) + padL('Stack', 20) + pad('Act RPS', 10) + pad('p50 ms', 9) + pad('p99 ms', 9));
  console.log(SEP);
  for (const lbl of ['50 RPS', '200 RPS', '500 RPS']) {
    if (map1[lbl]) {
      console.log(padL(lbl, 12) + padL('Gateway (3 backends)', 20) + pad(Math.round(map1[lbl].requests.mean),10) + pad(map1[lbl].latency.p50,9) + pad(map1[lbl].latency.p99,9));
    }
    if (map2[lbl]) {
      console.log(padL('', 12) + padL('Single backend', 20) + pad(Math.round(map2[lbl].requests.mean),10) + pad(map2[lbl].latency.p50,9) + pad(map2[lbl].latency.p99,9));
    }
    console.log('');
  }
  console.log(SEP);
}

main().catch(e => { console.error(e); process.exit(1); });
