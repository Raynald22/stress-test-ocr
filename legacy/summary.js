// Shared k6 result saver for the legacy (LBP) suite. Import and do
//   export const handleSummary = makeSummary('load');
// to get, when the run finishes:
//   - the normal coloured summary in the terminal, AND
//   - a timestamped report written into ./results/  (both .txt and .json)
//
// NOTE: run k6 from inside this legacy/ folder so ./results resolves.

import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

export function makeSummary(label) {
  return function handleSummary(data) {
    const ts = new Date().toISOString().replace('T', '_').replace(/[:.]/g, '-').slice(0, 19);
    const base = `results/${label}-${ts}`;
    return {
      stdout: textSummary(data, { indent: ' ', enableColors: true }),
      [`${base}.txt`]: textSummary(data, { indent: ' ', enableColors: false }),
      [`${base}.json`]: JSON.stringify(data, null, 2),
    };
  };
}
