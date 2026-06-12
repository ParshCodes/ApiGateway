/**
 * Benchmark against already-running services.
 * Run AFTER starting backends + gateway manually (or via full-bench.js).
 */
const autocannon = require('autocannon');

const GW  = 'http://localhost:3000/test';
const B1  = 'http://localhost:3001/test';

const p  = (v, n) => String(v).padStart(n);
const pL = (v, n) => String(v).padEnd(n);

function bench(url, connections, duration) {
  return new Promise((resolve, reject) => {
    const inst = autocannon({ url, connections, duration, pipelining: 1 }, (err, r) => {
      if (err) reject(err); else resolve(r);
    });
    autocannon.track(inst, { renderProgressBar: false });
  });
}

function printTable(title, rows) {
  const SEP = '─'.repeat(82);
  console.log('\n' + title);
  console.log(SEP);
  console.log(pL('Scenario',12)+p('Act RPS',9)+p('p50 ms',9)+p('p97.5ms',10)+p('p99 ms',9)+p('Errors',9)+p('Timeouts',10));
  console.log(SEP);
  for (const {label,r} of rows) {
    console.log(pL(label,12)+p(Math.round(r.requests.mean),9)+p(r.latency.p50,9)+p(r.latency.p97_5,10)+p(r.latency.p99,9)+p(r.errors,9)+p(r.timeouts,10));
  }
  console.log(SEP);
}

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║          API Gateway — Live Benchmark Results        ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  // ── Group 1: through gateway (3 backends, round-robin) ─────────────────
  console.log('■ Group 1  Gateway → 3 backends (round-robin, no rate limiting)\n');
  const g1 = [];
  for (const [label, conns, dur] of [
    ['50 RPS',    5,  12],
    ['200 RPS',  20,  15],
    ['500 RPS',  50,  15],
    ['1000 RPS', 100, 18],
  ]) {
    process.stdout.write(`  ${pL(label,10)} `);
    const r = await bench(GW, conns, dur);
    process.stdout.write(`→ ${Math.round(r.requests.mean)} rps  p50=${r.latency.p50}ms  err=${r.errors}\n`);
    g1.push({label, r});
  }

  // ── Group 2: direct to one backend (no gateway) ─────────────────────────
  console.log('\n■ Group 2  Direct to backend-1 only (single backend, no gateway)\n');
  const g2 = [];
  for (const [label, conns, dur] of [
    ['50 RPS',   5,  12],
    ['200 RPS', 20,  15],
    ['500 RPS', 50,  15],
  ]) {
    process.stdout.write(`  ${pL(label,10)} `);
    const r = await bench(B1, conns, dur);
    process.stdout.write(`→ ${Math.round(r.requests.mean)} rps  p50=${r.latency.p50}ms  err=${r.errors}\n`);
    g2.push({label, r});
  }

  // ── Print formatted tables ───────────────────────────────────────────────
  printTable('Group 1 — Gateway · 3 backends · no rate limiting', g1);
  printTable('Group 2 — Single backend direct (scaling baseline)', g2);

  // Scaling comparison
  const m1 = Object.fromEntries(g1.map(x=>[x.label,x.r]));
  const m2 = Object.fromEntries(g2.map(x=>[x.label,x.r]));
  const SEP = '─'.repeat(78);
  console.log('\nScaling Impact — gateway (3 backends) vs single backend');
  console.log(SEP);
  console.log(pL('Scenario',12)+pL('Deployment',24)+p('RPS',7)+p('p50 ms',9)+p('p99 ms',9)+p('Errors',9));
  console.log(SEP);
  for (const lbl of ['50 RPS','200 RPS','500 RPS']) {
    if (m1[lbl]) console.log(pL(lbl,12)+pL('Gateway · 3 backends',24)+p(Math.round(m1[lbl].requests.mean),7)+p(m1[lbl].latency.p50,9)+p(m1[lbl].latency.p99,9)+p(m1[lbl].errors,9));
    if (m2[lbl]) console.log(pL('',12)  +pL('Single backend',24)      +p(Math.round(m2[lbl].requests.mean),7)+p(m2[lbl].latency.p50,9)+p(m2[lbl].latency.p99,9)+p(m2[lbl].errors,9));
    console.log('');
  }
  console.log(SEP);

  // Raw JSON for README
  const out = {
    environment: 'Windows 11, Node.js 20, local (no Docker)',
    g1: g1.map(x=>({label:x.label,rps:Math.round(x.r.requests.mean),p50:x.r.latency.p50,p975:x.r.latency.p97_5,p99:x.r.latency.p99,errors:x.r.errors,timeouts:x.r.timeouts})),
    g2: g2.map(x=>({label:x.label,rps:Math.round(x.r.requests.mean),p50:x.r.latency.p50,p975:x.r.latency.p97_5,p99:x.r.latency.p99,errors:x.r.errors,timeouts:x.r.timeouts})),
  };
  console.log('\nRAW_JSON_START\n' + JSON.stringify(out) + '\nRAW_JSON_END\n');
}

main().catch(e => { console.error(e); process.exit(1); });
