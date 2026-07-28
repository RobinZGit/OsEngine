const fs = require('fs');
const lines = fs.readFileSync('server.js.pre-routes-bak', 'utf8').split(/\r?\n/);

function findFunctionEnd(startLine1) {
  let i = startLine1 - 1;
  let depth = 0;
  let started = false;
  let inStr = null;
  for (; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const prev = j > 0 ? line[j - 1] : '';
      if (inStr) {
        if (ch === inStr && prev !== '\\') inStr = null;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') {
        inStr = ch;
        continue;
      }
      if (ch === '{') {
        depth++;
        started = true;
      } else if (ch === '}') {
        depth--;
        if (started && depth === 0) return i + 1;
      }
    }
  }
  throw new Error('no end ' + startLine1);
}

const starts = {
  runIndicatorSyncBackground: 5143,
  fetchIndicatorById: 5177,
  rewriteFormulaBasesNode: 2271,
  parseLogicTradingParams: 4831,
  fillRealTbankAccountFromToken: 5270,
  resolveAccountConnection: 5412,
  handleDbError: 5460,
};

for (const [name, start] of Object.entries(starts)) {
  const end = findFunctionEnd(start);
  console.log(name, start, '->', end, 'len', end - start + 1);
}
