export function npmPackArtifacts(stdout: string): Array<{
  filename?: string;
  files?: Array<{ path: string }>;
}>;
