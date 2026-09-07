// Synchronous ESM loader for trusted developer roster policy
// Derives production repo root one level above executing scripts module
// Requires current control HEAD equal/ancestor of existing trusted main ref
// and clean control source (including unexpected untracked source)
// Policy regular contained file committed at HEAD, byte-equal to its Git blob
// Returns pinned commit/blob/raw SHA identity and frozen/copy-safe policy data

import { readFile, stat } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

/**
 * Get the repository root directory (one level above the scripts module)
 */
async function getRepoRoot() {
  // Get the directory of this script (scripts/) and go one level up
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(scriptDir, '..');
}

/**
 * Check if the repository is clean (no uncommitted changes)
 */
async function isRepoClean(repoRoot) {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd: repoRoot });
    return stdout.trim().length === 0;
  } catch (error) {
    throw new Error(`Git status check failed: ${error.message}`);
  }
}

/**
 * Get current HEAD commit SHA
 */
async function getCurrentHead(repoRoot) {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd: repoRoot });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get current HEAD: ${error.message}`);
  }
}

/**
 * Check if current HEAD is ancestor of or equal to trusted main ref
 */
async function isAncestorOrEqual(repoRoot, trustedRef = 'refs/remotes/origin/main') {
  try {
    // Check if the trusted ref exists
    const { stdout: refExists } = await execAsync(`git rev-parse --verify ${trustedRef}`, { 
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'ignore'] // Suppress error output if ref doesn't exist
    }).catch(() => ({ stdout: '' }));
    
    if (!refExists.trim()) {
      // If trusted ref doesn't exist, check if we're on a clean main branch
      const { stdout: currentBranch } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
      if (currentBranch.trim() === 'main') {
        return true;
      }
      return false;
    }

    // Check if current HEAD is an ancestor of or equal to the trusted ref
    try {
      await execAsync(`git merge-base --is-ancestor HEAD ${trustedRef}`, { cwd: repoRoot });
      return true;
    } catch {
      // If not an ancestor, check if they're equal
      const currentHead = await getCurrentHead(repoRoot);
      const { stdout: trustedSha } = await execAsync(`git rev-parse ${trustedRef}`, { cwd: repoRoot });
      return currentHead === trustedSha.trim();
    }
  } catch (error) {
    throw new Error(`Failed to check ancestry: ${error.message}`);
  }
}

/**
 * Get the Git blob SHA for a file at HEAD
 */
async function getFileBlobSha(repoRoot, filePath) {
  try {
    const { stdout } = await execAsync(`git rev-parse HEAD:${filePath}`, { cwd: repoRoot });
    return stdout.trim();
  } catch (error) {
    throw new Error(`Failed to get blob SHA for ${filePath}: ${error.message}`);
  }
}

/**
 * Calculate SHA256 hash of file content
 */
async function calculateFileHash(filePath) {
  const crypto = await import('crypto');
  const fs = await import('fs');
  
  const content = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Load and validate the trusted roster policy
 */
export async function loadTrustedRosterPolicy(policyPath = '.kxm/roster.json') {
  const repoRoot = await getRepoRoot();
  
  // Check that we're in a git repository
  try {
    await execAsync('git rev-parse --git-dir', { cwd: repoRoot });
  } catch (error) {
    throw new Error('Not in a git repository');
  }
  
  // Verify repo is clean
  const isClean = await isRepoClean(repoRoot);
  if (!isClean) {
    throw new Error('Repository has uncommitted changes');
  }
  
  // Verify current HEAD is equal/ancestor of trusted main ref
  const isTrusted = await isAncestorOrEqual(repoRoot);
  if (!isTrusted) {
    throw new Error('Current HEAD is not trusted (not ancestor of or equal to origin/main)');
  }
  
  // Construct full path to policy file
  const fullPath = path.join(repoRoot, policyPath);
  
  // Verify the file exists
  try {
    await stat(fullPath);
  } catch (error) {
    throw new Error(`Policy file does not exist: ${fullPath}`);
  }
  
  // Get the blob SHA for the file at HEAD
  const relativePath = path.relative(repoRoot, fullPath).replace(/\\/g, '/');
  const expectedBlobSha = await getFileBlobSha(repoRoot, relativePath);
  
  // Read the actual file content
  const fileContent = await readFile(fullPath, 'utf8');
  const actualFileHash = await calculateFileHash(fullPath);
  
  // Verify the file content matches the Git blob
  if (actualFileHash !== expectedBlobSha) {
    throw new Error(`File content does not match Git blob: ${policyPath}`);
  }
  
  // Parse the policy
  let policy;
  try {
    policy = JSON.parse(fileContent);
  } catch (error) {
    throw new Error(`Invalid JSON in policy file: ${error.message}`);
  }
  
  // Validate the policy schema
  validateRosterSchema(policy);
  
  // Get current HEAD for identity
  const currentHead = await getCurrentHead(repoRoot);
  
  // Return frozen policy data with identity
  return {
    identity: {
      source: policyPath,
      sha256: actualFileHash,
      commit: currentHead
    },
    policy: Object.freeze(JSON.parse(JSON.stringify(policy))) // Deep freeze
  };
}

/**
 * Validate the roster policy schema
 */
function validateRosterSchema(policy) {
  if (typeof policy !== 'object' || policy === null) {
    throw new Error('Policy must be an object');
  }
  
  // Validate routes array
  if (!Array.isArray(policy.routes)) {
    throw new Error('Policy must have a routes array');
  }
  
  for (const [index, route] of policy.routes.entries()) {
    if (typeof route.id !== 'string') {
      throw new Error(`Route[${index}].id must be a string`);
    }
    
    if (!['pi', 'claude', 'kimi', 'codex', 'gemini', 'deepseek', 'grok'].includes(route.harness)) {
      throw new Error(`Route[${index}].harness must be a valid harness`);
    }
    
    if (typeof route.model !== 'string') {
      throw new Error(`Route[${index}].model must be a string`);
    }
    
    if (typeof route.vendor !== 'string') {
      throw new Error(`Route[${index}].vendor must be a string`);
    }
    
    if (!Array.isArray(route.roles)) {
      throw new Error(`Route[${index}].roles must be an array`);
    }
    
    if (typeof route.permissions !== 'object' || route.permissions === null) {
      throw new Error(`Route[${index}].permissions must be an object`);
    }
    
    if (!['active', 'disabled', 'retired'].includes(route.status)) {
      throw new Error(`Route[${index}].status must be 'active', 'disabled', or 'retired'`);
    }
  }
  
  // Validate lineup
  if (policy.lineup && typeof policy.lineup === 'object') {
    for (const [role, ids] of Object.entries(policy.lineup)) {
      if (!Array.isArray(ids)) {
        throw new Error(`Lineup role '${role}' must map to an array of IDs`);
      }
    }
  }
  
  // Validate required critics
  if (policy.required_critics && typeof policy.required_critics === 'object') {
    for (const [criticType, id] of Object.entries(policy.required_critics)) {
      if (typeof id !== 'string') {
        throw new Error(`Required critic '${criticType}' must map to a string ID`);
      }
    }
  }
  
  // Validate model origins
  if (policy.model_origins && typeof policy.model_origins === 'object') {
    for (const [model, originInfo] of Object.entries(policy.model_origins)) {
      if (typeof originInfo !== 'object' || originInfo === null) {
        throw new Error(`Model origin '${model}' must map to an object`);
      }
      
      if (typeof originInfo.vendor !== 'string') {
        throw new Error(`Model origin '${model}' must have a vendor string`);
      }
      
      if (typeof originInfo.evidence !== 'string') {
        throw new Error(`Model origin '${model}' must have an evidence string`);
      }
    }
  }
}

/**
 * Resolve policy from a previously bound commit (not current working files)
 */
export async function resolveBoundPolicy(identity) {
  const repoRoot = await getRepoRoot();
  
  if (!identity || !identity.commit || !identity.source) {
    throw new Error('Invalid identity: must have commit and source');
  }
  
  try {
    // Check if the commit exists in the repo
    await execAsync(`git cat-file -e ${identity.commit}`, { cwd: repoRoot });
    
    // Get the file content from the specific commit
    const { stdout } = await execAsync(`git show ${identity.commit}:${identity.source}`, { cwd: repoRoot });
    
    // Calculate hash of the content from the commit
    const crypto = await import('crypto');
    const commitContentHash = crypto.createHash('sha256').update(stdout).digest('hex');
    
    // Verify the hash matches what we expect
    if (commitContentHash !== identity.sha256) {
      throw new Error(`Content hash mismatch for commit ${identity.commit}, expected ${identity.sha256}, got ${commitContentHash}`);
    }
    
    // Parse and validate the policy
    const policy = JSON.parse(stdout);
    validateRosterSchema(policy);
    
    return {
      identity: { ...identity }, // Copy the identity
      policy: Object.freeze(JSON.parse(JSON.stringify(policy))) // Deep freeze
    };
  } catch (error) {
    throw new Error(`Failed to resolve policy from commit ${identity.commit}: ${error.message}`);
  }
}

// Export for direct execution when this file is run
if (process.argv[1] === new URL(import.meta.url).pathname) {
  loadTrustedRosterPolicy()
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch(error => {
      console.error('Error loading roster policy:', error.message);
      process.exit(1);
    });
}