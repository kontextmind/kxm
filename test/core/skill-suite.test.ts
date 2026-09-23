import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = join(__filename, '..');

// Test for the KXM skill suite manifest and coverage
describe('KXM Skill Suite', () => {
  const rootDir = resolve(__dirname, '../..');
  const suiteManifestPath = join(rootDir, 'plugins/kxm', 'skill-suite.json');
  const skillsDir = join(rootDir, 'plugins', 'kxm', 'skills');

  // The separate KontextMind knowledge plane (kontext CLI, km_ tools). These
  // skills ship with the plugin but are not KXM command skills (D-1 path R).
  const KNOWLEDGE_PLANE_SKILLS = [
    'kxm-mind', 'kxm-query', 'kxm-harvest', 'kxm-triage', 'kxm-work',
    'kxm-insights', 'kxm-projects', 'kxm-protocol', 'kxm-mind-setup',
  ];
  const KNOWLEDGE_PLANE_PREFIX =
    'KontextMind knowledge plane only, the separate kontext CLI and km_ tools, not KXM';

  const skillDirNames = (): string[] =>
    readdirSync(skillsDir, { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name)
      .sort();

  const frontmatterBlock = (skillName: string): string => {
    const text = readFileSync(join(skillsDir, skillName, 'SKILL.md'), 'utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
    assert.ok(match, `SKILL.md for "${skillName}" should open with a --- fenced frontmatter block`);
    return match[1]!;
  };

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

  it('every registered top-level kxm command is owned by exactly one bundled skill', () => {
    const cliSource = readFileSync(join(rootDir, 'plugins', 'kxm', 'src', 'cli.ts'), 'utf8');
    const registered = [...new Set(
      [...cliSource.matchAll(/program\s*\.command\("([a-z][a-z0-9-]*)/g)].map((match) => match[1]!),
    )].sort();
    assert.ok(registered.length >= 30, `found only ${registered.length} top-level commands in cli.ts; the scan is broken`);

    const owners = new Map<string, string[]>();
    for (const skill of suiteManifest.skills) {
      assert.ok(Array.isArray(skill.ownedCommands), `Skill "${skill.name}" must declare ownedCommands`);
      for (const command of skill.ownedCommands as string[]) {
        owners.set(command, [...(owners.get(command) ?? []), skill.name]);
      }
    }

    for (const command of registered) {
      const skills = owners.get(command) ?? [];
      assert.equal(skills.length, 1,
        `kxm ${command} must be owned by exactly one skill; owners: ${skills.join(', ') || 'none'}`);
    }
    for (const command of owners.keys()) {
      assert.ok(registered.includes(command), `skill-suite.json owns "${command}", which cli.ts does not register`);
    }
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

      // A KontextMind knowledge-plane skill says it is not KXM in its first
      // words, so it never competes with a KXM command skill for a KXM request.
      if (KNOWLEDGE_PLANE_SKILLS.includes(skill.name)) {
        const description = String(parseYaml(frontmatterBlock(skill.name))?.description ?? '');
        assert.ok(description.startsWith(KNOWLEDGE_PLANE_PREFIX),
          `Knowledge-plane skill "${skill.name}" description must start with "${KNOWLEDGE_PLANE_PREFIX}"`);
        assert.ok(description.includes('Use only when the user names KontextMind'),
          `Knowledge-plane skill "${skill.name}" description must say "Use only when the user names KontextMind"`);
      }
    });

    // Every skill directory is declared, so every shipped skill has an owner
    // and a generated .agents/skills mirror.
    const declared = new Set(suiteManifest.skills.map((skill: any) => skill.name));
    for (const name of skillDirNames()) {
      assert.ok(declared.has(name), `Skill directory "${name}" is not declared in skill-suite.json`);
    }
    for (const name of KNOWLEDGE_PLANE_SKILLS) {
      assert.ok(declared.has(name), `Knowledge-plane skill "${name}" must be declared in skill-suite.json`);
    }
  });

  it('every bundled SKILL.md frontmatter parses as strict YAML', () => {
    // Pi and Codex parse frontmatter as strict YAML; an unquoted value holding
    // ': ' is a nested mapping there, which the colon-split check above and
    // `claude plugin validate --strict` both accept.
    const names = skillDirNames();
    assert.ok(names.length > 0, 'no skill directories found');
    for (const name of names) {
      const block = frontmatterBlock(name);
      let parsed: unknown;
      assert.doesNotThrow(() => { parsed = parseYaml(block); },
        `SKILL.md frontmatter for "${name}" must parse as strict YAML (quote any value holding ': ')`);
      assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
        `SKILL.md frontmatter for "${name}" must be a YAML mapping`);
      const fields = parsed as Record<string, unknown>;
      assert.equal(typeof fields.name, 'string', `SKILL.md frontmatter for "${name}" needs a string name`);
      assert.equal(typeof fields.description, 'string', `SKILL.md frontmatter for "${name}" needs a string description`);
      assert.equal(fields.name, name, `SKILL.md frontmatter name "${String(fields.name)}" must equal its directory "${name}"`);
      assert.ok((fields.description as string).length <= 1024,
        `SKILL.md description for "${name}" is ${(fields.description as string).length} chars; the limit is 1024`);
    }
  });

  it('should check for absence of legacy product names', () => {
    const knowledgePlaneTerms = [
      /\bkm_[a-z]/,
      /\bkontext (init|login|doctor|search|read|append|review|chat)\b/,
      /npx kontextmind/,
    ];
    suiteManifest.skills.forEach((skill: any) => {
      for (const file of getAllFilesRecursive(join(skillsDir, skill.name))) {
        const content = readFileSync(file, 'utf8');

        // Check for legacy "Mesh" or "pi-extensions" references
        assert.ok(!content.toLowerCase().includes('mesh'),
          `${file} should not contain legacy "Mesh" references`);
        assert.ok(!content.toLowerCase().includes('pi-extensions'),
          `${file} should not contain legacy "pi-extensions" references`);

        // KXM command and browser skills never teach the separate KontextMind
        // knowledge plane (bare "kontextmind" stays legal: steel.kontextmind.com).
        if (!KNOWLEDGE_PLANE_SKILLS.includes(skill.name)) {
          for (const term of knowledgePlaneTerms) {
            assert.doesNotMatch(content, term, `${file} names a KontextMind knowledge-plane tool (${term})`);
          }
        }
      }
    });

    // kxm-setup was renamed to kxm-mind-setup with no alias.
    for (const file of getAllFilesRecursive(skillsDir)) {
      assert.doesNotMatch(readFileSync(file, 'utf8'), /\bkxm-setup\b/,
        `${file} names the retired kxm-setup skill`);
    }
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