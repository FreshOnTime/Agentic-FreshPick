import { randomBytes, createHash } from 'node:crypto';

const id = process.argv[2];
if (!id || !/^[a-z0-9_-]{1,64}$/.test(id)) {
  console.error('Usage: npm run a2a:partner -- partner-slug');
  process.exit(1);
}
const token = randomBytes(32).toString('base64url');
console.log('Store this token in the partner’s secret manager; never commit it or paste it into CI logs:');
console.log(token);
console.log('\nAppend this entry to the server-only A2A_PARTNERS JSON array:');
console.log(JSON.stringify({ id, tokenSha256: createHash('sha256').update(token).digest('hex') }));
