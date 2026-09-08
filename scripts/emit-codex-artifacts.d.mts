export const CODEX_COMMANDS_BLOCK: string;

export interface EmitCodexArtifactsResult {
  readonly destSkillsDir: string;
  readonly agentsPath: string;
  readonly agentsUpdated: boolean;
}

export function emitCodexArtifacts(repoRoot?: string): EmitCodexArtifactsResult;
