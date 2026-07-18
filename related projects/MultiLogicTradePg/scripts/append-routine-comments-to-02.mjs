import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const f02 = path.join(root, '02_multilogictrade_functions_and_procedures.sql');
const commentsPath = path.join(root, 'sql', 'routine_comments_missing.sql');
let comments = fs.readFileSync(commentsPath, 'utf8');
comments = comments.replace(/^-- @include sql\/routine_comments_missing\.sql\r?\n/, '');

const marker = '-- @optional-http-block';
const block =
  '\n\n-- ===========================================================================\n' +
  '-- @include sql/routine_comments_missing.sql (дублируется ниже)\n' +
  '-- ===========================================================================\n\n' +
  comments +
  '\n';

let sql = fs.readFileSync(f02, 'utf8');
const re =
  /\n-- =+\n-- @include sql\/routine_comments_missing\.sql[\s\S]*?(?=\n-- @optional-http-block)/;
if (re.test(sql)) {
  sql = sql.replace(re, block);
  console.log('Replaced existing routine_comments block in 02');
} else if (sql.includes(marker)) {
  sql = sql.replace(marker, `${block}${marker}`);
  console.log('Inserted routine_comments block before @optional-http-block');
} else {
  throw new Error('@optional-http-block not found in 02');
}
fs.writeFileSync(f02, sql);
console.log('OK, 02 bytes:', sql.length);
