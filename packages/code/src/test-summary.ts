/** Extracts pass/fail counts from common test runner output (vitest, jest, mocha, pytest, go, cargo). */
export function parseTestSummary(output: string): { passed?: number; failed?: number; total?: number } {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  let m: RegExpExecArray | null;
  // vitest:  "Tests  1 failed | 4 passed (5)"
  if ((m = /Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed(?:\s*\|\s*\d+\s+\w+)*\s*\((\d+)\)/.exec(clean))) {
    return { failed: Number(m[1] ?? 0), passed: Number(m[2]), total: Number(m[3]) };
  }
  if ((m = /Tests\s+(\d+)\s+failed\s*\((\d+)\)/.exec(clean))) return { failed: Number(m[1]), passed: 0, total: Number(m[2]) };
  // jest: "Tests:       1 failed, 4 passed, 5 total"
  if ((m = /Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(\d+) passed, (\d+) total/.exec(clean))) {
    return { failed: Number(m[1] ?? 0), passed: Number(m[2]), total: Number(m[3]) };
  }
  // node:test: "# pass 4" / "# fail 1"
  const pass = /^#\s*pass\s+(\d+)/m.exec(clean);
  const fail = /^#\s*fail\s+(\d+)/m.exec(clean);
  if (pass || fail) {
    const p = Number(pass?.[1] ?? 0);
    const f = Number(fail?.[1] ?? 0);
    return { passed: p, failed: f, total: p + f };
  }
  // mocha: "4 passing" / "1 failing"
  const mp = /(\d+)\s+passing/.exec(clean);
  const mf = /(\d+)\s+failing/.exec(clean);
  if (mp) return { passed: Number(mp[1]), failed: Number(mf?.[1] ?? 0), total: Number(mp[1]) + Number(mf?.[1] ?? 0) };
  // pytest: "1 failed, 4 passed in 0.12s"
  const pf = /(\d+)\s+failed/.exec(clean);
  const pp = /(\d+)\s+passed/.exec(clean);
  if ((pf || pp) && /\bin\s+[\d.]+s\b/.test(clean)) {
    const p = Number(pp?.[1] ?? 0);
    const f = Number(pf?.[1] ?? 0);
    return { passed: p, failed: f, total: p + f };
  }
  // cargo: "test result: ok. 4 passed; 0 failed"
  if ((m = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(clean))) {
    return { passed: Number(m[1]), failed: Number(m[2]), total: Number(m[1]) + Number(m[2]) };
  }
  return {};
}

/** Keeps the informative parts of long command output for the model: head, failures and tail. */
export function condenseOutput(output: string, maxChars = 6_000): string {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (clean.length <= maxChars) return clean;
  const lines = clean.split('\n');
  const failureLines = lines.filter((l) => /(fail|error|✗|×|assert|expected|exception|traceback)/i.test(l)).slice(0, 60);
  const head = clean.slice(0, Math.floor(maxChars * 0.2));
  const tail = clean.slice(-Math.floor(maxChars * 0.45));
  const middle = failureLines.join('\n').slice(0, Math.floor(maxChars * 0.35));
  return `${head}\n…\n[failure lines]\n${middle}\n…\n${tail}`;
}
