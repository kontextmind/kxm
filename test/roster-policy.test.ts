import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'assert';
import fs from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Import the functions from the .mjs file
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rosterPolicyPath = path.resolve(__dirname, '../scripts/roster-policy.mjs');

// Dynamic import since it's an ES module
const { loadTrustedRosterPolicy, resolveBoundPolicy } = await import(rosterPolicyPath);

describe('roster-policy loader', () => {
  let testDir: string;
  let originalDir: string;

  beforeEach(async () => {
    originalDir = process.cwd();
    
    // Create a temporary directory for testing
    testDir = await fs.mkdtemp(path.join(tmpdir(), 'roster-test-'));
    process.chdir(testDir);
    
    // Initialize a git repository
    spawnSync('git', ['init'], { cwd: testDir });
    spawnSync('git', ['config', 'user.name', 'Test User'], { cwd: testDir });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: testDir });
    
    // Create a basic .kxm directory
    await fs.mkdir('.kxm', { recursive: true });
  });

  afterEach(async () => {
    process.chdir(originalDir);
    // Clean up the temporary directory
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch (err) {
      // Ignore cleanup errors in tests
    }
  });

  describe('loadTrustedRosterPolicy', () => {
    it('should successfully load a valid policy from a clean, trusted repository', async () => {
      // Create a valid roster policy
      const validPolicy = {
        routes: [
          {
            id: 'test-route-1',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true, execute: true },
            status: 'active'
          }
        ],
        lineup: {
          implementer: ['test-route-1']
        },
        required_critics: {
          'review-arch': 'test-route-2',
          'review-cli': 'test-route-3'
        },
        model_origins: {
          'gpt-4o': {
            vendor: 'openai',
            evidence: 'committed-config'
          }
        }
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(validPolicy, null, 2));

      // Add and commit the file to make it part of the repository
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Add roster policy'], { cwd: testDir });
      // Create origin/main reference to simulate trusted state
      spawnSync('git', ['branch', '-f', 'origin/main', 'HEAD'], { cwd: testDir, shell: true });

      const result = await loadTrustedRosterPolicy();

      assert.ok(result.identity);
      assert.ok(result.identity.source);
      assert.ok(result.identity.sha256);
      assert.ok(result.identity.commit);
      assert.ok(result.policy);
      assert.strictEqual(result.policy.routes.length, 1);
      assert.strictEqual(result.policy.routes[0].id, 'test-route-1');
      assert.strictEqual(result.policy.routes[0].model, 'gpt-4o');
    });

    it('should reject an invalid policy schema', async () => {
      // Create an invalid roster policy (missing required fields)
      const invalidPolicy = {
        invalidField: 'this should not be here'
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(invalidPolicy, null, 2));

      // Add and commit the file to make it part of the repository
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Add invalid roster policy'], { cwd: testDir });
      // Create origin/main reference to simulate trusted state
      spawnSync('git', ['branch', '-f', 'origin/main', 'HEAD'], { cwd: testDir, shell: true });

      await assert.rejects(
        () => loadTrustedRosterPolicy(),
        /Policy must have a routes array/
      );
    });

    it('should reject a repository with uncommitted changes', async () => {
      // Create a valid policy file but don't commit it
      const validPolicy = {
        routes: [
          {
            id: 'test-route-1',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true, execute: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(validPolicy, null, 2));

      await assert.rejects(
        () => loadTrustedRosterPolicy(),
        /Repository has uncommitted changes/
      );
    });

    it('should reject a repository that is not trusted (not ancestor of origin/main)', async () => {
      // Create a valid policy file and commit it
      const validPolicy = {
        routes: [
          {
            id: 'test-route-1',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true, execute: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(validPolicy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Add roster policy'], { cwd: testDir });

      // Don't create origin/main reference to simulate untrusted state
      // This should cause the trust check to fail

      await assert.rejects(
        () => loadTrustedRosterPolicy(),
        /Current HEAD is not trusted/
      );
    });

    it('should reject a policy file that does not match its Git blob', async () => {
      // Create a valid policy file and commit it
      const validPolicy = {
        routes: [
          {
            id: 'test-route-1',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true, execute: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(validPolicy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Add roster policy'], { cwd: testDir });
      // Create origin/main reference to simulate trusted state
      spawnSync('git', ['branch', '-f', 'origin/main', 'HEAD'], { cwd: testDir, shell: true });

      // Now modify the file to not match the committed version
      const modifiedPolicy = {
        ...validPolicy,
        routes: [
          {
            ...validPolicy.routes[0],
            id: 'modified-route'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(modifiedPolicy, null, 2));

      await assert.rejects(
        () => loadTrustedRosterPolicy(),
        /File content does not match Git blob/
      );
    });
  });

  describe('resolveBoundPolicy', () => {
    it('should successfully resolve a policy from a specific commit', async () => {
      // Create a valid policy file and commit it
      const validPolicy = {
        routes: [
          {
            id: 'test-route-1',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true, execute: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(validPolicy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      const commitResult = spawnSync('git', ['commit', '-m', 'Add roster policy'], { cwd: testDir });
      
      // Get the commit hash
      const commitHash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: testDir }).stdout.toString().trim();
      
      // Create origin/main reference to simulate trusted state
      spawnSync('git', ['branch', '-f', 'origin/main', 'HEAD'], { cwd: testDir, shell: true });

      // Calculate the expected SHA256 of the file content
      const crypto = await import('crypto');
      const contentHash = crypto.createHash('sha256')
        .update(JSON.stringify(validPolicy, null, 2))
        .digest('hex');

      const identity = {
        source: '.kxm/roster.json',
        sha256: contentHash,
        commit: commitHash
      };

      const result = await resolveBoundPolicy(identity);

      assert.ok(result.identity);
      assert.strictEqual(result.identity.commit, commitHash);
      assert.strictEqual(result.identity.sha256, contentHash);
      assert.ok(result.policy);
      assert.strictEqual(result.policy.routes.length, 1);
      assert.strictEqual(result.policy.routes[0].id, 'test-route-1');
    });

    it('should reject an invalid identity', async () => {
      const invalidIdentity = {
        source: '.kxm/roster.json',
        // Missing sha256 and commit
      };

      await assert.rejects(
        () => resolveBoundPolicy(invalidIdentity as any),
        /Invalid identity/
      );
    });

    it('should reject a commit that does not exist', async () => {
      const fakeIdentity = {
        source: '.kxm/roster.json',
        sha256: 'somefakehashthatis40characterslongxxxxxxx',
        commit: '0000000000000000000000000000000000000000'
      };

      await assert.rejects(
        () => resolveBoundPolicy(fakeIdentity),
        /Failed to resolve policy/
      );
    });

    it('should reject a policy when content hash does not match', async () => {
      // Create a valid policy file and commit it
      const validPolicy = {
        routes: [
          {
            id: 'test-route-1',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true, execute: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(validPolicy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Add roster policy'], { cwd: testDir });
      
      // Get the commit hash
      const commitHash = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: testDir }).stdout.toString().trim();
      
      // Create origin/main reference to simulate trusted state
      spawnSync('git', ['branch', '-f', 'origin/main', 'HEAD'], { cwd: testDir, shell: true });

      // Use an incorrect SHA256 hash
      const wrongIdentity = {
        source: '.kxm/roster.json',
        sha256: 'wronghashthats40characterslongxxxxxxxxxxxx',
        commit: commitHash
      };

      await assert.rejects(
        () => resolveBoundPolicy(wrongIdentity),
        /Content hash mismatch/
      );
    });
  });

  describe('real Git fixture tests', () => {
    it('should handle successful committed/trusted policy', async () => {
      // Test successful committed/trusted policy scenario
      const policy = {
        routes: [
          {
            id: 'trusted-route',
            harness: 'grok',
            model: 'grok-4.6',
            vendor: 'xai',
            roles: ['implementer'],
            permissions: { edit: true },
            status: 'active'
          }
        ],
        lineup: {
          implementer: ['trusted-route']
        },
        required_critics: {
          'review-arch': 'fable-reviewer',
          'review-cli': 'sol-reviewer'
        },
        model_origins: {
          'grok-4.6': {
            vendor: 'xai',
            evidence: 'committed-config'
          }
        }
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(policy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Add trusted policy'], { cwd: testDir });
      // Create origin/main reference to simulate trusted state
      spawnSync('git', ['branch', '-f', 'origin/main', 'HEAD'], { cwd: testDir, shell: true });

      const result = await loadTrustedRosterPolicy();
      assert.ok(result);
      assert.strictEqual(result.policy.routes[0].id, 'trusted-route');
    });

    it('should handle missing/untracked policy file', async () => {
      // Don't create the policy file at all
      await assert.rejects(
        () => loadTrustedRosterPolicy(),
        /Policy file does not exist/
      );
    });

    it('should handle dirty/untracked control source', async () => {
      // Create policy file but don't commit it (simulating untracked)
      const policy = {
        routes: [
          {
            id: 'untracked-route',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(policy, null, 2));

      await assert.rejects(
        () => loadTrustedRosterPolicy(),
        /Repository has uncommitted changes/
      );
    });

    it('should handle candidate ahead of trusted ref', async () => {
      // Create initial policy and commit
      const initialPolicy = {
        routes: [
          {
            id: 'initial-route',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(initialPolicy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Initial policy'], { cwd: testDir });
      
      // Create origin/main reference pointing to this commit
      spawnSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: testDir });

      // Now create a new commit that advances HEAD beyond origin/main
      const updatedPolicy = {
        routes: [
          {
            id: 'updated-route',
            harness: 'claude',
            model: 'fable',
            vendor: 'anthropic',
            roles: ['planner'],
            permissions: { plan: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(updatedPolicy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Updated policy'], { cwd: testDir });

      // Now HEAD is ahead of origin/main, which should cause trust check to fail
      await assert.rejects(
        () => loadTrustedRosterPolicy(),
        /Current HEAD is not trusted/
      );
    });

    it('should handle raw-byte mismatch', async () => {
      // Create policy file and commit it
      const policy = {
        routes: [
          {
            id: 'byte-match-route',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(policy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Policy with byte mismatch'], { cwd: testDir });
      // Create origin/main reference to simulate trusted state
      spawnSync('git', ['branch', '-f', 'origin/main', 'HEAD'], { cwd: testDir, shell: true });

      // Modify the file content to create a byte mismatch
      const modifiedPolicy = {
        ...policy,
        routes: [
          {
            ...policy.routes[0],
            id: 'modified-after-commit'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(modifiedPolicy, null, 2));

      await assert.rejects(
        () => loadTrustedRosterPolicy(),
        /File content does not match Git blob/
      );
    });

    it('should handle forged identity', async () => {
      // Create a valid policy file and commit it
      const policy = {
        routes: [
          {
            id: 'real-route',
            harness: 'pi',
            model: 'gpt-4o',
            vendor: 'openai',
            roles: ['implementer'],
            permissions: { edit: true },
            status: 'active'
          }
        ]
      };

      await fs.writeFile('.kxm/roster.json', JSON.stringify(policy, null, 2));
      spawnSync('git', ['add', '.'], { cwd: testDir });
      spawnSync('git', ['commit', '-m', 'Real policy'], { cwd: testDir });
      
      // Get the real commit hash
      const realCommit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: testDir }).stdout.toString().trim();
      
      // Create origin/main reference to simulate trusted state
      spawnSync('git', ['branch', '-f', 'origin/main', 'HEAD'], { cwd: testDir, shell: true });

      // Try to resolve with forged identity (different commit, same source)
      const forgedIdentity = {
        source: '.kxm/roster.json',
        sha256: '0000000000000000000000000000000000000000000000000000000000000000', // Wrong hash
        commit: realCommit
      };

      await assert.rejects(
        () => resolveBoundPolicy(forgedIdentity),
        /Content hash mismatch/
      );
    });
  });
});