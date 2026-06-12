const autocannon = require('autocannon');

const pad = (v, n) => String(v).padStart(n);
const padL = (v, n) => String(v).padEnd(n);

async function run(url, label, connections, duration) {
  return new Promise((resolve, reject) => {
    autocannon({ url, connections, duration, pipelining: 1 }, (err, res) => {
      if (err) return reject(err);
      resolve({ label, res });
    });
  });
}

async function main() {
  const rows = [];
  for (const [label, conns, dur] of [
    ['50 RPS',   5,  10],
    ['200 RPS',  20, 12],
    ['500 RPS',  50, 12],
  ]) {
    process.stdout.write(`  ${label}...`);
    const r = await run('http://localhost:3001/bench', label, conns, dur);
    process.stdout.write(` ${Math.round(r.res.requests.mean)} rps  p50=${r.res.latency.p50}ms  p99=${r.res.latency.p99}ms\n`);
    rows.push(r);
  }
  // Print JSON for easy parsing
  console.log('\nJSON:', JSON.stringify(rows.map(r => ({
    label: r.label,
    rps: Math.round(r.res.requests.mean),
    p50: r.res.latency.p50,
    p975: r.res.latency.p97_5,
    p99: r.res.latency.p99,
    errors: r.res.errors,
    timeouts: r.res.timeouts,
  }))));
}
main().catch(e => { console.error(e); process.exit(1); });
