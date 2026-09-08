import { test } from 'node:test';
import { preflightRequest } from '../../scripts/harness-run.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
// Each fixture imports its own exact loader and helper copies. No cwd override,
// trust override, live-repository import, or mocked Git authority.
async function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kxm roster % '));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const write = (name: string, contents: string) => { mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); writeFileSync(path.join(root, name), contents); };
  git('init', '-b', 'main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture'); git('config', 'commit.gpgsign', 'false');
  mkdirSync(path.join(root, 'scripts'));
  for (const file of ['roster-policy.mjs', 'harness-run.mjs']) copyFileSync(path.join(repo, 'scripts', file), path.join(root, 'scripts', file));
  write('evidence.md', 'Reviewed model-origin evidence, fixture only.\n');
  const policy = JSON.parse(readFileSync(path.join(repo, '.kxm/roster.json'), 'utf8'));
  policy.model_origins['openrouter/qwen/qwen3-coder-plus'].evidence = { source: 'evidence.md', sha256: hash(readFileSync(path.join(root, 'evidence.md'))) };
  const save = () => write('.kxm/roster.json', JSON.stringify(policy, null, 2) + '\n');
  const commit = (trusted = true) => { git('add', '.'); git('commit', '-m', 'Fixture'); if (trusted) git('update-ref', 'refs/remotes/origin/main', 'HEAD'); };
  save(); commit();
  const loader = await import(pathToFileURL(path.join(root, 'scripts/roster-policy.mjs')).href) as typeof import('../../scripts/roster-policy.mjs');
  return { root, git, write, policy, save, commit, ...loader, close: () => rmSync(root, { recursive: true, force: true }) };
}
test('trusted committed policy has exact immutable commit/blob/raw hash identity', async t => {
  const f = await fixture(); t.after(f.close);
  const result = f.loadTrustedRosterPolicy();
  assert.equal(result.identity.commit, f.git('rev-parse', 'HEAD'));
  assert.equal(result.identity.blob, f.git('rev-parse', 'HEAD:.kxm/roster.json'));
  assert.equal(result.identity.sha256, hash(readFileSync(path.join(f.root, '.kxm/roster.json'))));
  assert.equal(result.policy.routes['qwen-openrouter-pi']!.vendor, 'alibaba');
  assert.throws(() => (result.policy.routes['grok-native']!.roles as string[]).push('planner'), TypeError);
  assert.throws(() => (result.identity as { commit: string }).commit = 'forged', TypeError);
  assert.deepEqual(f.resolveBoundPolicy(result.identity), result);
});
test('historical binding reads policy and origin evidence at the pinned commit', async t => {
  const f = await fixture(); t.after(f.close);
  const old = f.loadTrustedRosterPolicy();
  f.write('evidence.md', 'A new reviewed catalog\n');
  f.policy.model_origins['openrouter/qwen/qwen3-coder-plus'].evidence.sha256 = hash('A new reviewed catalog\n');
  f.policy.routes['grok-native']!.status = 'retired'; f.policy.lineup.writer = ['qwen-openrouter-pi'];
  f.save(); f.commit();
  assert.equal(f.loadTrustedRosterPolicy().policy.routes['grok-native']!.status, 'retired');
  assert.deepEqual(f.resolveBoundPolicy(old.identity), old);
});
for (const kind of ['missing-ref', 'ahead', 'untracked-source', 'dirty-helper', 'dirty-policy', 'staged-policy', 'missing-policy', 'symlink-policy', 'symlink-parent', 'skip-worktree-byte-mismatch'] as const) {
  test(`refuses ${kind} without treating another failure as proof`, async t => {
    const f = await fixture(); t.after(f.close);
    assert.ok(f.loadTrustedRosterPolicy());
    let expected = /dirty or untracked|Git evidence|missing or not a regular|regular contained|differs from committed/;
    if (kind === 'missing-ref') f.git('update-ref', '-d', 'refs/remotes/origin/main');
    if (kind === 'ahead') { f.write('new-source.mjs', 'export {};'); f.commit(false); }
    if (kind === 'untracked-source') f.write('new-source.mjs', 'export {};');
    if (kind === 'dirty-helper') f.write('scripts/harness-run.mjs', '// changed helper');
    if (kind === 'dirty-policy' || kind === 'staged-policy') { f.write('.kxm/roster.json', '{}'); if (kind === 'staged-policy') f.git('add', '.kxm/roster.json'); }
    if (kind === 'missing-policy') { rmSync(path.join(f.root, '.kxm/roster.json')); f.commit(); }
    if (kind === 'symlink-policy') { f.write('copy.json', readFileSync(path.join(f.root, '.kxm/roster.json'), 'utf8')); rmSync(path.join(f.root, '.kxm/roster.json')); symlinkSync('../copy.json', path.join(f.root, '.kxm/roster.json')); f.commit(); }
    if (kind === 'symlink-parent') { f.git('update-index', '--skip-worktree', '.kxm/roster.json'); const bytes = readFileSync(path.join(f.root, '.kxm/roster.json'), 'utf8'); rmSync(path.join(f.root, '.kxm'), { recursive: true }); const outside = mkdtempSync(path.join(tmpdir(), 'kxm-policy-parent-')); t.after(() => rmSync(outside, { recursive: true, force: true })); writeFileSync(path.join(outside, 'roster.json'), bytes); symlinkSync(outside, path.join(f.root, '.kxm')); }
    if (kind === 'skip-worktree-byte-mismatch') { f.git('update-index', '--skip-worktree', '.kxm/roster.json'); f.write('.kxm/roster.json', '{}'); expected = /differs from committed/; }
    assert.throws(() => f.loadTrustedRosterPolicy(), expected);
  });
}
test('config-only nonnative addition needs exact pinned origin evidence', async t => {
  const f = await fixture(); t.after(f.close);
  f.policy.routes['new-model'] = { harness: 'pi', model: 'openrouter/example-lab/coder-next', vendor: 'example-lab', roles: ['writer'], permissions: ['edit'], status: 'admitted' };
  f.policy.model_origins['openrouter/example-lab/coder-next'] = { vendor: 'example-lab', evidence: { source: 'evidence.md', sha256: hash(readFileSync(path.join(f.root, 'evidence.md'))) } };
  f.policy.lineup.writer.push('new-model'); f.save(); f.commit();
  assert.equal(f.loadTrustedRosterPolicy().policy.routes['new-model']!.model, 'openrouter/example-lab/coder-next');
});
const invalid: [string, (p: any) => void, RegExp][] = [
  ['unknown key', p => p.extra = true, /unknown keys/],
  ['missing schema', p => delete p.schema, /missing or unknown/],
  ['old status', p => p.routes['grok-native'].status = 'active', /status/],
  ['unsupported harness', p => p.routes['grok-native'].harness = 'kimi', /harness/],
  ['Claude edit', p => p.routes['fable-claude'].permissions = ['edit'], /permissions/],
  ['Grok critic', p => p.routes['grok-native'].roles = ['reviewer-arch'], /roles/],
  ['missing origin', p => p.model_origins = {}, /missing exact model origin/],
  ['unverified evidence hash', p => p.model_origins['openrouter/qwen/qwen3-coder-plus'].evidence.sha256 = '0'.repeat(64), /evidence hash/],
  ['escaping source', p => p.model_origins['openrouter/qwen/qwen3-coder-plus'].evidence.source = '../evidence.md', /contained/],
  ['billing vendor as origin', p => { p.routes['qwen-openrouter-pi'].vendor = 'openrouter'; p.model_origins['openrouter/qwen/qwen3-coder-plus'].vendor = 'openrouter'; }, /origin\/vendor/],
  ['native origin relabeled', p => p.routes['qwen-openrouter-pi'].vendor = 'OpenAI', /native vendor/],
  ['native alias in model', p => { p.routes['qwen-openrouter-pi'].model = 'openrouter/x-ai/fake'; }, /native vendor/],
  ['moonshot alias', p => p.routes['qwen-openrouter-pi'].vendor = 'moonshotai', /native vendor/],
  ['native vendor mismatch', p => p.routes['fable-claude'].vendor = 'other', /vendor\/model/],
  ['retired lineup', p => p.routes['qwen-openrouter-pi'].status = 'retired', /not admitted/],
  ['duplicate lineup', p => p.lineup.writer.push('grok-native'), /duplicate/],
  ['missing critic', p => delete p.required_critics['review-cli'], /missing or unknown/],
  ['forged critic id', p => p.required_critics['review-cli'] = 'grok-native', /required critic/],
  ['array critics', p => p.required_critics['review-cli'] = ['sol-codex'], /required critic/],
  ['Pi readonly writer', p => p.routes['qwen-openrouter-pi'].permissions = ['read-only'], /writer requires edit/],
  ['Pi critic edit', p => p.routes['qwen-openrouter-pi'].roles.push('reviewer-arch'), /cannot edit/],
];
for (const [name, mutate, expected] of invalid) test(`closed policy refuses ${name}`, async t => {
  const f = await fixture(); t.after(f.close); mutate(f.policy); f.save(); f.commit();
  assert.throws(() => f.loadTrustedRosterPolicy(), expected);
});
test('independent vendors required for critics and every admitted writer', async t => {
  const f = await fixture(); t.after(f.close);
  f.policy.routes['pi-critic'] = { harness: 'pi', model: 'openrouter/qwen/qwen3-coder-plus', vendor: 'alibaba', roles: ['reviewer-cli'], permissions: ['read-only'], status: 'admitted' };
  f.policy.lineup['reviewer-cli'] = ['pi-critic']; f.policy.required_critics['review-cli'] = 'pi-critic'; f.save(); f.commit();
  assert.throws(() => f.loadTrustedRosterPolicy(), /writer and critics/);
  f.policy.routes['qwen-openrouter-pi'].status = 'retired'; f.policy.lineup.writer = ['grok-native'];
  f.policy.routes['pi-critic'].roles.push('reviewer-arch'); f.policy.lineup['reviewer-arch'] = ['pi-critic']; f.policy.required_critics['review-arch'] = 'pi-critic'; f.save(); f.commit();
  assert.throws(() => f.loadTrustedRosterPolicy(), /critics must have independent/);
});
test('forged, incomplete, shell-shaped and untrusted historical identities refuse', async t => {
  const f = await fixture(); t.after(f.close); const good = f.loadTrustedRosterPolicy().identity;
  for (const bad of [{ ...good, blob: '0'.repeat(40) }, { ...good, sha256: '0'.repeat(64) }, { ...good, commit: 'HEAD;touch BAD' }, { commit: good.commit }, { ...good, extra: true }]) {
    assert.throws(() => f.resolveBoundPolicy(bad as typeof good), /refused/);
  }
  f.write('untrusted.txt', 'candidate'); f.commit(false); const candidate = f.git('rev-parse', 'HEAD'); f.git('reset', '--hard', good.commit);
  assert.throws(() => f.resolveBoundPolicy({ ...good, commit: candidate }), /Git evidence/);
});

test('index flags cannot hide modified control helpers', async t => {
  const f = await fixture(); t.after(f.close);
  f.git('update-index', '--assume-unchanged', 'scripts/harness-run.mjs');
  f.write('scripts/harness-run.mjs', '// hidden modification');
  assert.throws(() => f.loadTrustedRosterPolicy(), /hidden index flags/);
});

test('shipping policy and guide evidence bind without replacing their hash', async t => {
  const f = await fixture(); t.after(f.close);
  f.write('.kxm/roster.json', readFileSync(path.join(repo, '.kxm/roster.json'), 'utf8'));
  f.write('docs/workflow-guide.md', readFileSync(path.join(repo, 'docs/workflow-guide.md'), 'utf8'));
  f.commit();
  assert.deepEqual(f.loadTrustedRosterPolicy().policy, JSON.parse(readFileSync(path.join(repo, '.kxm/roster.json'), 'utf8')));
});
test('config-only native model choice does not grant live dispatch capability', async t => {
  const f = await fixture(); t.after(f.close);
  f.policy.routes['grok-native'].model = 'future-reviewed-model'; f.save(); f.commit();
  const route = f.loadTrustedRosterPolicy().policy.routes['grok-native']!;
  assert.equal(route.model, 'future-reviewed-model');
  assert.throws(() => preflightRequest({ schema: 'kxm.harness-request.v1', harness: route.harness, model: route.model, role: 'writer', permission: 'edit', prompt_file: 'unused.md' }), /grok does not accept model/);
});

function addNousFixture(policy: any, permission: 'read-only' | 'edit' = 'read-only') {
  policy.routes['nous-fixture'] = { harness: 'pi', model: 'nous-portal/tencent/hy4-preview', vendor: 'tencent', roles: [permission === 'edit' ? 'writer' : 'experiment'], permissions: [permission], status: 'admitted' };
  policy.model_origins['nous-portal/tencent/hy4-preview'] = { vendor: 'tencent', evidence: { ...policy.model_origins['openrouter/qwen/qwen3-coder-plus'].evidence } };
}
test('config-only Nous experiment uses the shared provider ceiling and pinned fixture evidence', async t => {
  const f = await fixture(); t.after(f.close); addNousFixture(f.policy); f.save(); f.commit();
  assert.equal(f.loadTrustedRosterPolicy().policy.routes['nous-fixture']!.model, 'nous-portal/tencent/hy4-preview');
});
test('billing provider cannot be an origin even in an unused mapping', async t => {
  const f = await fixture(); t.after(f.close); addNousFixture(f.policy);
  f.policy.model_origins['nous-portal/tencent/hy4-preview'].vendor = 'nous-portal'; f.save(); f.commit();
  assert.throws(() => f.loadTrustedRosterPolicy(), /origin\/vendor/);
});
test('Nous native-vendor relabeling and unknown Pi prefixes refuse', async t => {
  const f = await fixture(); t.after(f.close); addNousFixture(f.policy);
  f.policy.routes['nous-fixture'].vendor = 'Anthropic'; f.save(); f.commit();
  assert.throws(() => f.loadTrustedRosterPolicy(), /native vendor/);
  f.policy.routes['nous-fixture'].vendor = 'tencent'; f.policy.routes['nous-fixture'].model = 'unknown-provider/tencent/hy4-preview'; f.save(); f.commit();
  assert.throws(() => f.loadTrustedRosterPolicy(), /unsupported Pi provider/);
});
test('config-only Nous writer does not become a live admitted writer', async t => {
  const f = await fixture(); t.after(f.close); addNousFixture(f.policy, 'edit'); f.save(); f.commit();
  const route = f.loadTrustedRosterPolicy().policy.routes['nous-fixture']!;
  assert.throws(() => preflightRequest({ schema: 'kxm.harness-request.v1', harness: 'pi', model: route.model, role: 'writer', permission: 'edit', prompt_file: 'unused.md' }), /pi writer refuses unsupported route/);
});
