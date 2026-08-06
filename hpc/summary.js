// Shared k6 result saver for the HPC suite. Every script that imports this and
// does
//   export const handleSummary = makeSummary('load');
// will, when the run finishes:
//   - still print the normal summary to the terminal, AND
//   - write a timestamped report into ./results/  (both .txt and .json)
//
// NOTE: run k6 from inside this hpc/ folder so ./results resolves. The
// results/ folder already exists here.

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

export function makeSummary(label) {
  return function handleSummary(data) {
    const ts = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
    const base = `results/${label}-${ts}`;
    return {
      // keep the coloured summary in the terminal
      stdout: textSummary(data, { indent: ' ', enableColors: true }),
      // plain-text copy for saving/attaching to a bug report
      [`${base}.txt`]: textSummary(data, { indent: ' ', enableColors: false }),
      // full machine-readable metrics
      [`${base}.json`]: JSON.stringify(data, null, 2),
    };
  };
}
