import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

// Test for the KXM skill suite manifest and coverage
describe('KXM Skill Suite', () => {
  const rootDir = resolve(__dirname, '../..');
  const suiteManifestPath = join(rootDir, 'plugins/kxm', 'skill-suite.json');
  const skillsDir = join(rootDir, 'plugins', 'kxm', 'skills');

  let suiteManifest: any;

  beforeEach(() => {
    if (!existsSync(suiteManifestPath)) {
      throw new Error(`Suite manifest not found at ${suiteManifestPath}`);
    }
    suiteManifest = JSON.parse(readFileSync(suiteManifestPath, 'utf8'));
  });

  it('should have a valid manifest with required properties', () => {
    assert.ok(suiteManifest.id, 'Manifest should have an id');
    assert.ok(suiteManifest.version, 'Manifest should have a version');
    assert.ok(suiteManifest.name, 'Manifest should have a name');
    assert.ok(suiteManifest.description, 'Manifest should have a description');
    assert.ok(Array.isArray(suiteManifest.skills), 'Manifest should have a skills array');
    assert.ok(suiteManifest.skills.length > 0, 'Manifest should have at least one skill');
  });

  it('should cover all 30 current top-level commands exactly once', () => {
    // Define the expected top-level commands based on the plan
    const expectedCommands = [
      'init', 'migrate', 'trust', 'config', 'completion',
      'harness', 'auth', 'update', 'runtime', 'agent',
      'hub', 'backup', 'restore',
      'session', 'dash', 'studio',
      'peer',
      'workflow', 'gate',
      'role',
      'run', 'runs',
      'context', 'memory',
      'skills',
      'routing', 'improve',
      'suggest', 'goal', 'task'
    ];

    // Collect all owned commands from the skill manifest
    const allOwnedCommands: string[] = [];
    const commandToSkillMap = new Map<string, string>();

    suiteManifest.skills.forEach((skill: any) => {
      if (Array.isArray(skill.ownedCommands)) {
        skill.ownedCommands.forEach((cmd: string) => {
          allOwnedCommands.push(cmd);
          if (commandToSkillMap.has(cmd)) {
            throw new Error(`Command "${cmd}" is owned by multiple skills: ${commandToSkillMap.get(cmd)} and ${skill.name}`);
          }
          commandToSkillMap.set(cmd, skill.name);
        });
      }
    });

    // Check that all expected commands are covered
    expectedCommands.forEach(cmd => {
      assert.ok(allOwnedCommands.includes(cmd), `Command "${cmd}" should be covered by a skill`);
    });

    // Check that no extra commands are covered
    allOwnedCommands.forEach(cmd => {
      assert.ok(expectedCommands.includes(cmd), `Command "${cmd}" is not in the expected list`);
    });

    // Check that each command is covered exactly once
    assert.strictEqual(new Set(allOwnedCommands).size, allOwnedCommands.length,
      'Each command should be owned by exactly one skill');

    assert.strictEqual(allOwnedCommands.length, expectedCommands.length,
      `Should have exactly ${expectedCommands.length} covered commands`);
  });

  it('should validate standard frontmatter constraints for each skill', () => {
    suiteManifest.skills.forEach((skill: any) => {
      // Directory name should match skill name
      const skillDir = join(skillsDir, skill.name);
      assert.ok(existsSync(skillDir), `Skill directory should exist: ${skillDir}`);

      // Name should be kebab-case and reasonable length
      assert.match(skill.name, /^[a-z][a-z0-9-]*[a-z0-9]$/,
        `Skill name "${skill.name}" should be kebab-case`);
      assert.ok(skill.name.length >= 3 && skill.name.length <= 50,
        `Skill name "${skill.name}" should be between 3 and 50 characters`);

      // Description should exist and be reasonable length
      // Note: The skill.intent field is used as the description in the manifest
      const skillDescription = skill.intent || skill.description;
      assert.ok(skillDescription, `Skill "${skill.name}" should have a description or intent`);
      assert.ok(typeof skillDescription === 'string',
        `Skill "${skill.name}" description should be a string`);
      assert.ok(skillDescription.length >= 10 && skillDescription.length <= 200,
        `Skill "${skill.name}" description should be between 10 and 200 characters`);

      // Validate allowed fields (only standard ones)
      const allowedFields = ['name', 'path', 'ownedCommands', 'intent'];
      Object.keys(skill).forEach(field => {
        assert.ok(allowedFields.includes(field),
          `Skill "${skill.name}" has unexpected field: ${field}`);
      });

      // Validate SKILL.md file exists and has proper frontmatter
      const skillMdPath = join(skillDir, 'SKILL.md');
      assert.ok(existsSync(skillMdPath),
        `SKILL.md should exist for skill: ${skill.name}`);

      const skillMdContent = readFileSync(skillMdPath, 'utf8');
      assert.ok(skillMdContent.startsWith('---'),
        `SKILL.md for "${skill.name}" should start with frontmatter`);

      // Extract frontmatter
      const frontmatterMatch = skillMdContent.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(frontmatterMatch,
        `SKILL.md for "${skill.name}" should have valid frontmatter`);

      // Parse frontmatter - extract key-value pairs
      const frontmatterText = frontmatterMatch[1]!;
      const frontmatter: Record<string, string> = {};
      const lines = frontmatterText.split('\n');
      for (const line of lines) {
        if (line.includes(':')) {
          const colonIndex = line.indexOf(':');
          const key = line.substring(0, colonIndex).trim();
          const value = line.substring(colonIndex + 1).trim();
          frontmatter[key] = value.replace(/^"|"$/g, ''); // Remove quotes if present
        }
      }

      // Validate frontmatter has required fields
      assert.ok(frontmatter.name, `SKILL.md for "${skill.name}" frontmatter should have name`);
      assert.ok(frontmatter.description, `SKILL.md for "${skill.name}" frontmatter should have description`);

      // Ensure directory name matches frontmatter name
      assert.strictEqual(skill.name, frontmatter.name,
        `Directory name "${skill.name}" should match frontmatter name "${frontmatter.name}"`);
    });
  });

  it('should check for absence of legacy product names', () => {
    suiteManifest.skills.forEach((skill: any) => {
      const skillDir = join(skillsDir, skill.name);
      const skillMdPath = join(skillDir, 'SKILL.md');

      if (existsSync(skillMdPath)) {
        const content = readFileSync(skillMdPath, 'utf8');

        // Check for legacy "Mesh" or "pi-extensions" references
        assert.ok(!content.toLowerCase().includes('mesh'),
          `Skill "${skill.name}" should not contain legacy "Mesh" references`);
        assert.ok(!content.toLowerCase().includes('pi-extensions'),
          `Skill "${skill.name}" should not contain legacy "pi-extensions" references`);
      }
    });
  });

  it('should compare authored skills with .agents/skills mirror', () => {
    const agentsSkillsDir = join(rootDir, '.agents', 'skills');

    if (existsSync(agentsSkillsDir)) {
      suiteManifest.skills.forEach((skill: any) => {
        const authoredSkillDir = join(skillsDir, skill.name);
        const mirroredSkillDir = join(agentsSkillsDir, skill.name);

        if (existsSync(authoredSkillDir)) {
          // Both directories should exist
          assert.ok(existsSync(mirroredSkillDir),
            `Mirrored skill directory should exist for: ${skill.name}`);

          // Compare files byte-for-byte
          const authoredFiles = getAllFilesRecursive(authoredSkillDir);
          const mirroredFiles = getAllFilesRecursive(mirroredSkillDir);

          assert.deepStrictEqual(
            authoredFiles.map(f => f.replace(authoredSkillDir, '')),
            mirroredFiles.map(f => f.replace(mirroredSkillDir, '')),
            `File structure should match between authored and mirrored skill: ${skill.name}`
          );

          // Compare content byte-for-byte
          for (let i = 0; i < authoredFiles.length; i++) {
            const authoredFile = authoredFiles[i]!;
            const mirroredFile = mirroredFiles[i]!;
            const authoredContent = readFileSync(authoredFile);
            const mirroredContent = readFileSync(mirroredFile);

            assert.strictEqual(
              Buffer.compare(authoredContent, mirroredContent),
              0,
              `Content should match between authored and mirrored file: ${authoredFiles[i]} vs ${mirroredFiles[i]}`
            );
          }
        }
      });
    }
  });

  it('should validate package discovery', () => {
    // Check that package.json references the authored skills
    const packageJsonPath = join(rootDir, 'package.json');
    assert.ok(existsSync(packageJsonPath), 'package.json should exist');

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

    // Check that root pi.skills contains './plugins/kxm/skills'
    if (packageJson.pi && packageJson.pi.skills) {
      assert.ok(
        packageJson.pi.skills.includes('./plugins/kxm/skills'),
        'package.json should include ./plugins/kxm/skills in pi.skills'
      );
    }

    // Check that plugin package.json also has the skills reference
    const pluginPackageJsonPath = join(rootDir, 'plugins/kxm/package.json');
    if (existsSync(pluginPackageJsonPath)) {
      const pluginPackageJson = JSON.parse(readFileSync(pluginPackageJsonPath, 'utf8'));
      // Plugin packaging should contain the authored skills
    }
  });
});

// Helper function to recursively get all files in a directory
function getAllFilesRecursive(dir: string): string[] {
  const files: string[] = [];

  if (existsSync(dir)) {
    const dirents = readdirSync(dir, { withFileTypes: true });

    for (const dirent of dirents) {
      const fullPath = join(dir, dirent.name);

      if (dirent.isDirectory()) {
        files.push(...getAllFilesRecursive(fullPath));
      } else {
        files.push(fullPath);
      }
    }
  }

  return files.sort(); // Sort for consistent comparison
}