/** Unwired developer policy foundation. No dispatch or acceptance authority. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { NATIVE_PI_BRAKE_PROVIDERS, PI_ALLOWED_PROVIDERS, PI_ANTIGRAVITY_MODEL_ID, PI_NATIVE_VENDOR_PROVIDERS, ROUTES } from './harness-run.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY = '.kxm/roster.yaml';
const RETIRED_POLICY = '.kxm/roster.json';
const TRUSTED = 'refs/remotes/origin/main';
const ROLES = ['writer', 'planner', 'reviewer-arch', 'reviewer-cli', 'experiment'];
const ALIASES = Object.freeze({ 'x-ai': 'xai', moonshotai: 'moonshot', 'google-ai': 'google', qwen: 'alibaba' });
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = message => { throw new Error(`Roster policy refused: ${message}`); };
const git = (...args) => {
  try { return execFileSync('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch { return refuse(`Git evidence unavailable (${args[0]})`); }
};
const gitText = (...args) => git(...args).toString('utf8').trim();
export const canonicalVendor = value => {
  if (typeof value !== 'string') return '';
  const lower = value.toLowerCase();
  return ALIASES[lower] ?? lower;
};
const canonical = canonicalVendor;
const own = (obj, key) => Object.hasOwn(obj, key);
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse(`${label} must be an object`);
}
function keys(value, expected, label) {
  record(value, label);
  if (Object.keys(value).length !== expected.length || expected.some(key => !own(value, key))) refuse(`${label} has missing or unknown keys`);
}
function text(value, label) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\s\x00-\x1f]/u.test(value)) refuse(`${label} must be a nonempty token`);
}
function list(value, allowed, label) {
  if (!Array.isArray(value) || !value.length || value.some(item => !allowed.includes(item)) || new Set(value).size !== value.length) refuse(`${label} contains unsupported or duplicate values`);
}
function sourcePath(value) {
  text(value, 'source path');
  if (path.posix.isAbsolute(value) || value.includes('\\') || value.split('/').some(part => !part || part === '.' || part === '..')) refuse('source path must be contained and relative');
  return value;
}
function objectId(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) refuse(`invalid ${label}`);
}
function digest(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) refuse('invalid SHA256');
}
function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function control() {
  if (existsSync(path.join(ROOT, RETIRED_POLICY))) refuse(`retired ${RETIRED_POLICY} present; use ${POLICY}`);
  if (realpathSync(gitText('rev-parse', '--show-toplevel')) !== realpathSync(ROOT)) refuse('module is outside its control repository');
  const head = gitText('rev-parse', '--verify', 'HEAD^{commit}');
  const trusted = gitText('rev-parse', '--verify', `${TRUSTED}^{commit}`);
  git('merge-base', '--is-ancestor', head, trusted);
  const flags = git('ls-files', '-v', '-z').toString('utf8').split('\0').filter(Boolean);
  if (flags.some(entry => entry.slice(2) !== POLICY && (entry[0] === 'S' || entry[0] === entry[0].toLowerCase()))) refuse('hidden index flags on control source');
  if (git('status', '--porcelain=v1', '--untracked-files=all').length) refuse('dirty or untracked control source');
  return { head, trusted };
}
function unchanged(before) {
  const after = control();
  if (before.head !== after.head || before.trusted !== after.trusted) refuse('control changed while reading policy');
}
function blobAt(commit, source) {
  sourcePath(source);
  const entry = git('ls-tree', '-z', commit, '--', source).toString('utf8');
  const match = /^(100644|100755) blob ([a-f0-9]{40}(?:[a-f0-9]{24})?)\t([^\0]+)\0$/u.exec(entry);
  if (!match || match[3] !== source) refuse('source is missing or not a regular committed file');
  return { blob: match[2], bytes: git('cat-file', 'blob', match[2]) };
}
function workingBytes(source) {
  let current = ROOT;
  const parts = sourcePath(source).split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || (i === parts.length - 1 ? !info.isFile() : !info.isDirectory())) refuse('working policy must be a regular contained file');
  }
  return readFileSync(current);
}
export function validateRosterDocument(policy, readBlob) {
  keys(policy, ['schema', 'routes', 'lineup', 'required_critics', 'model_origins'], 'policy');
  if (policy.schema !== 'kxm.developer-roster.v1') refuse('unsupported schema');
  record(policy.routes, 'routes'); record(policy.lineup, 'lineup'); record(policy.model_origins, 'model origins');
  if (!Object.keys(policy.routes).length) refuse('empty routes');
  if (typeof readBlob !== 'function') refuse('origin evidence reader required');
  for (const [model, origin] of Object.entries(policy.model_origins)) {
    text(model, 'origin model'); keys(origin, ['vendor', 'evidence'], 'origin');
    text(origin.vendor, 'origin vendor');
    if (PI_ALLOWED_PROVIDERS.includes(canonical(origin.vendor.toLowerCase()))) refuse('origin/vendor must name the model vendor, not billing provider');
    const evidenceKeys = origin.evidence.commit === undefined ? ['source', 'sha256'] : ['source', 'commit', 'sha256'];
    keys(origin.evidence, evidenceKeys, 'origin evidence'); digest(origin.evidence.sha256);
    sourcePath(origin.evidence.source);
    if (origin.evidence.commit !== undefined) objectId(origin.evidence.commit, 'origin evidence commit');
    const bytes = readBlob(origin.evidence.source, origin.evidence.commit);
    if (bytes == null || sha256(bytes) !== origin.evidence.sha256) refuse('origin evidence hash mismatch');
  }
  for (const [id, route] of Object.entries(policy.routes)) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)) refuse('invalid route id');
    keys(route, ['harness', 'model', 'vendor', 'roles', 'permissions', 'status'], 'route');
    text(route.harness, 'harness'); text(route.model, 'model'); text(route.vendor, 'vendor');
    if (!own(ROUTES, route.harness)) refuse('unsupported harness');
    const ceiling = ROUTES[route.harness];
    list(route.roles, ceiling.roles, 'roles'); list(route.permissions, ceiling.permissions, 'permissions');
    if (!['admitted', 'retired'].includes(route.status)) refuse('unsupported status');
    if (route.harness === 'pi') {
      const parts = route.model.split('/');
      const provider = parts[0];
      const owned = Object.hasOwn(PI_NATIVE_VENDOR_PROVIDERS, provider)
        ? canonical(PI_NATIVE_VENDOR_PROVIDERS[provider])
        : '';
      const minParts = owned ? 2 : 3;
      const maxParts = owned ? 2 : Number.POSITIVE_INFINITY;
      if (
        parts.length < minParts
        || parts.length > maxParts
        || !PI_ALLOWED_PROVIDERS.includes(provider)
        || parts.some(part => !part)
        || (owned && !PI_ANTIGRAVITY_MODEL_ID.test(parts[1]))
      ) refuse('unsupported Pi provider/model');
      const vendor = canonical(route.vendor.toLowerCase());
      if (owned) {
        if (owned !== vendor) refuse('native vendor cannot use Pi');
      } else {
        const prefix = canonical(parts[1].toLowerCase());
        if (NATIVE_PI_BRAKE_PROVIDERS.includes(prefix) || NATIVE_PI_BRAKE_PROVIDERS.includes(vendor)) refuse('native vendor cannot use Pi');
      }
      if (!own(policy.model_origins, route.model)) refuse('missing exact model origin');
      const origin = policy.model_origins[route.model];
      if (canonical(origin.vendor.toLowerCase()) !== vendor || PI_ALLOWED_PROVIDERS.includes(vendor)) refuse('model origin/vendor mismatch');
      if (route.roles.includes('writer') && (route.permissions.length !== 1 || route.permissions[0] !== 'edit')) refuse('Pi writer requires edit permission only');
      if (route.permissions.includes('edit') && route.roles.some(role => !['writer', 'experiment'].includes(role))) refuse('Pi critic/planner cannot edit');
    } else if (canonical(route.vendor.toLowerCase()) !== ceiling.provider || route.model.includes('/')) refuse('native route vendor/model mismatch');
  }
  for (const [role, ids] of Object.entries(policy.lineup)) {
    if (!ROLES.includes(role)) refuse('unsupported lineup role');
    list(ids, Object.keys(policy.routes), 'lineup');
    if (ids.some(id => policy.routes[id].status !== 'admitted' || !policy.routes[id].roles.includes(role))) refuse('lineup route not admitted for role');
  }
  for (const role of ['writer', 'planner', 'reviewer-arch', 'reviewer-cli']) if (!own(policy.lineup, role)) refuse('required lineup missing');
  keys(policy.required_critics, ['review-arch', 'review-cli'], 'required critics');
  const critics = [];
  for (const [kind, role] of [['review-arch', 'reviewer-arch'], ['review-cli', 'reviewer-cli']]) {
    const id = policy.required_critics[kind];
    if (typeof id !== 'string' || !policy.lineup[role].includes(id)) refuse('required critic not in admitted lineup');
    const route = policy.routes[id];
    if (route.permissions.length !== 1 || route.permissions[0] !== 'read-only') refuse('critic must be read-only');
    critics.push(canonical(route.vendor.toLowerCase()));
  }
  if (critics[0] === critics[1]) refuse('critics must have independent vendors');
  for (const route of Object.values(policy.routes)) {
    if (route.status === 'admitted' && route.roles.includes('writer') && critics.includes(canonical(route.vendor.toLowerCase()))) refuse('writer and critics must have independent vendors');
  }
  return policy;
}
function validate(bytes, commit, trusted) {
  let policy;
  try { policy = YAML.parse(bytes.toString('utf8')); } catch { refuse('invalid policy YAML'); }
  if (policy === undefined || policy === null || typeof policy !== 'object' || Array.isArray(policy)) refuse('invalid policy YAML');
  const readBlob = (source, pinnedCommit) => {
    if (pinnedCommit === undefined) return blobAt(commit, source).bytes;
    // A pinned evidence commit decouples the digest from later edits to the
    // evidence file; the pinned commit itself must be part of trusted history.
    git('merge-base', '--is-ancestor', pinnedCommit, trusted);
    return blobAt(pinnedCommit, source).bytes;
  };
  return validateRosterDocument(policy, readBlob);
}
export function loadTrustedRosterPolicy() {
  const snapshot = control();
  const { blob, bytes } = blobAt(snapshot.head, POLICY);
  if (!workingBytes(POLICY).equals(bytes)) refuse('working policy differs from committed bytes');
  const policy = validate(bytes, snapshot.head, trusted);
  unchanged(snapshot);
  return frozen({ identity: { commit: snapshot.head, blob, sha256: sha256(bytes) }, policy });
}
export function resolveBoundPolicy(identity) {
  keys(identity, ['commit', 'blob', 'sha256'], 'identity');
  objectId(identity.commit, 'commit'); objectId(identity.blob, 'blob'); digest(identity.sha256);
  const snapshot = control();
  git('merge-base', '--is-ancestor', identity.commit, snapshot.trusted);
  const { blob, bytes } = blobAt(identity.commit, POLICY);
  if (blob !== identity.blob || sha256(bytes) !== identity.sha256) refuse('bound identity mismatch');
  const policy = validate(bytes, identity.commit, snapshot.trusted);
  unchanged(snapshot);
  return frozen({ identity: { ...identity }, policy });
}
