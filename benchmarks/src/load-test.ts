/**
 * Autocannon load-test runner.
 *
 * Scenarios tested:
 *   1. No rate limiting, 3 backends (baseline)
 *   2. Rate limiting enabled (100 req/min), 3 backends
 *   3. No rate limiting, 1 backend (scaling comparison)
 *
 * Usage:
 *   npx ts-node src/load-test.ts [gatewayUrl]
 *   npx ts-node src/load-test.ts http://localhost:3000
 */

import autocannon, { Result } from 'autocannon';

const GATEWAY_URL = process.argv[2] || 'http://localhost:3000';
const TARGET_PATH = process.argv[3] || '/api/test';

interface Scenario {
  name: string;
  connections: number; // concurrent connections
  duration: number;    // seconds
  note: string;
}

const scenarios: Scenario[] = [
  { name: '50 RPS',   connections: 5,  duration: 10, note: 'Low traffic' },
  { name: '200 RPS',  connections: 20, duration: 15, note: 'Moderate traffic' },
  { name: '500 RPS',  connections: 50, duration: 15, note: 'High traffic' },
  { name: '1000 RPS', connections: 100, duration: 20, note: 'Stress test' },
];

interface Row {
  scenario: string;
  rps: number;
  latencyP50: number;
  latencyP97: number;  // autocannon exposes p97.5, not p95
  latencyP99: number;
  errors: number;
  timeouts: number;
}

async function runScenario(s: Scenario): Promise<Row> {
  console.log(`\n  Running: ${s.name} (${s.connections} connections × ${s.duration}s)...`);

  const result = await new Promise<Result>((resolve, reject) => {
    const instance = autocannon(
      {
        url: `${GATEWAY_URL}${TARGET_PATH}`,
        connections: s.connections,
        duration: s.duration,
        pipelining: 1,
        headers: { 'x-api-key': 'bench-client' },
      },
      (err, result) => {
        if (err) reject(err);
        else resolve(result);
      },
    );

    // Stream dots so the terminal doesn't look frozen
    autocannon.track(instance, { renderProgressBar: false });
  });

  return {
    scenario: s.name,
    rps: Math.round(result.requests.mean),
    latencyP50: result.latency.p50,
    latencyP97: result.latency.p97_5,
    latencyP99: result.latency.p99,
    errors: result.errors,
    timeouts: result.timeouts,
  };
}

function printTable(title: string, rows: Row[]): void {
  const SEP = '─'.repeat(85);
  console.log(`\n${title}`);
  console.log(SEP);
  console.log(
    padR('Scenario', 12),
    padL('RPS', 8),
    padL('p50 ms', 9),
    padL('p97.5 ms', 10),
    padL('p99 ms', 9),
    padL('Errors', 8),
    padL('Timeouts', 10),
  );
  console.log(SEP);
  for (const r of rows) {
    console.log(
      padR(r.scenario, 12),
      padL(r.rps, 8),
      padL(r.latencyP50, 9),
      padL(r.latencyP97, 10),
      padL(r.latencyP99, 9),
      padL(r.errors, 8),
      padL(r.timeouts, 10),
    );
  }
  console.log(SEP);
}

function padR(s: string | number, n: number): string {
  return String(s).padEnd(n);
}
function padL(s: string | number, n: number): string {
  return String(s).padStart(n);
}

async function main() {
  console.log(`\n${'═'.repeat(85)}`);
  console.log(`  API Gateway Load Test`);
  console.log(`  Target: ${GATEWAY_URL}${TARGET_PATH}`);
  console.log(`${'═'.repeat(85)}`);

  // ------------------------------------------------------------------
  // Scenario group 1: 3 backends, varying RPS
  // ------------------------------------------------------------------
  console.log('\n[Group 1] 3 backends (no rate limiting override)');
  console.log('  → Start the gateway with RATE_LIMIT_ENABLED=false for this group.\n');
  const group1: Row[] = [];
  for (const s of scenarios) {
    group1.push(await runScenario(s));
  }
  printTable('Results — 3 backends, no rate limiting', group1);

  // ------------------------------------------------------------------
  // Scenario group 2: rate limiting enabled (100 req/min default)
  // ------------------------------------------------------------------
  console.log('\n[Group 2] 3 backends, rate limiting ENABLED (100 req/60s window)');
  console.log('  → Restart the gateway with RATE_LIMIT_ENABLED=true, RATE_LIMIT_MAX=100\n');
  const group2: Row[] = [];
  for (const s of scenarios) {
    group2.push(await runScenario(s));
  }
  printTable('Results — 3 backends, with rate limiting', group2);

  // ------------------------------------------------------------------
  // Scaling comparison: run the first 3 scenarios against a single backend
  // ------------------------------------------------------------------
  console.log('\n[Group 3] 1 backend (simulate by stopping backends 2 & 3)');
  console.log('  → Stop backends 2 and 3. The gateway will route all traffic to backend 1.\n');
  const group3: Row[] = [];
  for (const s of scenarios.slice(0, 3)) {
    group3.push(await runScenario(s));
  }
  printTable('Results — 1 backend, no rate limiting (scaling comparison)', group3);

  // ------------------------------------------------------------------
  // Summary
  // ------------------------------------------------------------------
  console.log('\n  Done. Paste the tables above into the README results section.\n');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
