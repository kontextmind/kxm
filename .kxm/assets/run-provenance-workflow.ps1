$ErrorActionPreference = "Stop"

function New-EphemeralSecret {
  return [Convert]::ToHexString(
    [Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
  ).ToLowerInvariant()
}

$env:PI_MESH_HOST = "127.0.0.1"
$env:PI_MESH_PORT = "7331"
$env:PI_MESH_SERVER_URL = "http://127.0.0.1:7331"
$projectName = "provenance-demo"
$adminSecret = New-EphemeralSecret
$projectSecret = New-EphemeralSecret
$workflowSecret = New-EphemeralSecret
$signalSecret = New-EphemeralSecret
$projectTokens = @{}
$projectTokens[$projectName] = $projectSecret
$env:PI_MESH_AUTH_TOKEN = $adminSecret
$env:PI_MESH_PROJECT_TOKENS = $projectTokens | ConvertTo-Json -Compress
$env:PI_MESH_WORKFLOW_SECRET = $workflowSecret
$env:PI_MESH_WORKFLOW_SIGNAL_SECRET = $signalSecret
$env:PI_MESH_WORKFLOW_ID = "provenance-review"

$nodeCommand = (Get-Command node).Source
$workdir = (Get-Location).Path
$kxmScript = Join-Path $workdir "scripts\kxm.mjs"
$meshExtension = Join-Path $workdir "plugins\kxm-mesh\src\extension.ts"
$meshSkill = Join-Path $workdir "plugins\kxm-mesh\skills\kxm-mesh"
$piAgentDirectory = if ($env:PI_CODING_AGENT_DIR) {
  $env:PI_CODING_AGENT_DIR
} else {
  Join-Path $env:USERPROFILE ".pi\agent"
}
$providerExtension = Join-Path $piAgentDirectory "npm\node_modules\pi-antigravity\src\index.ts"
$env:PI_MESH_WEBHOOK_WORKFLOWS_FILE = Join-Path $workdir "examples\provenance-workflow.json"
$env:PI_MESH_WORKER_EXTENSION_PATHS = @($meshExtension, $providerExtension) -join [IO.Path]::PathSeparator
$env:PI_MESH_WORKER_SKILL_PATHS = $meshSkill
$env:PI_MESH_WORKER_TOOL_TIMEOUT_MS = "180000"
Remove-Item Env:PI_MESH_WEBHOOK_WORKFLOWS -ErrorAction SilentlyContinue

foreach ($requiredFile in @($kxmScript, $meshExtension, $providerExtension)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required release-workflow file not found: $requiredFile"
  }
}
if (-not (Test-Path -LiteralPath $meshSkill -PathType Container)) {
  throw "Required release-workflow skill directory not found: $meshSkill"
}

$hub = $null
$workers = @()
try {
  $hub = Start-Process `
    -FilePath $nodeCommand `
    -ArgumentList @($kxmScript, "--json", "--workspace", ".kxm", "mesh", "hub") `
    -WorkingDirectory $workdir `
    -WindowStyle Hidden `
    -PassThru

  Start-Sleep -Seconds 4
  & $nodeCommand $kxmScript --json --workspace .kxm gate validate
  if ($LASTEXITCODE -ne 0) { throw "Workflow validation failed" }
  & $nodeCommand $kxmScript --json --workspace .kxm mesh status
  if ($LASTEXITCODE -ne 0) { throw "Hub did not become ready" }

  # Workers receive only the project credential. They cannot call the
  # administrative degradation endpoint or replay signed webhooks.
  $env:PI_MESH_AUTH_TOKEN = $projectSecret
  Remove-Item Env:PI_MESH_PROJECT_TOKENS -ErrorAction SilentlyContinue
  Remove-Item Env:PI_MESH_WORKFLOW_SECRET -ErrorAction SilentlyContinue
  Remove-Item Env:PI_MESH_WORKFLOW_SIGNAL_SECRET -ErrorAction SilentlyContinue
  $workers = @(
    @{ Name = "coordinator"; Model = "antigravity/gemini-3.1-pro"; FallbackModels = "openrouter/qwen/qwen3-coder-plus"; Tools = "read,grep,find,ls,kxm_list,kxm_fanout,kxm_get,kxm_await,kxm_workflow_get,kxm_workflow_checkpoint,kxm_workflow_record" },
    @{ Name = "reviewer-claude"; Model = "openrouter/qwen/qwen3-coder-plus"; FallbackModels = "antigravity/gemini-3.1-pro"; Tools = "read,grep,find,ls" },
    @{ Name = "reviewer-grok"; Model = "openrouter/z-ai/glm-5.3-flash"; FallbackModels = "antigravity/gemini-3.1-pro"; Tools = "read,grep,find,ls" }
  ) | ForEach-Object {
    $workerArguments = @(
      $kxmScript,
      "--json",
      "--workspace",
      ".kxm",
      "agent",
      "worker",
      "--name",
      $_.Name,
      "--project",
      $projectName,
      "--model",
      $_.Model,
      "--fallback-models",
      $_.FallbackModels,
      "--tools",
      $_.Tools,
      "--fresh-start"
    )
    Start-Process `
      -FilePath $nodeCommand `
      -ArgumentList $workerArguments `
      -WorkingDirectory $workdir `
      -WindowStyle Hidden `
      -PassThru
  }

  # Restore operator-only credentials after child creation. Already-started
  # workers retain only the project token and no webhook secrets.
  $env:PI_MESH_AUTH_TOKEN = $adminSecret
  $env:PI_MESH_WORKFLOW_SECRET = $workflowSecret
  $env:PI_MESH_WORKFLOW_SIGNAL_SECRET = $signalSecret

  $ready = $false
  $readinessDeadline = (Get-Date).AddSeconds(90)
  do {
    $exitedWorkers = @($workers | Where-Object HasExited)
    if ($exitedWorkers.Count -gt 0) {
      throw "A release-review worker exited before registration: $($exitedWorkers.Id -join ', ')"
    }
    $statusOutput = & $nodeCommand $kxmScript --json --workspace .kxm mesh status
    if ($LASTEXITCODE -eq 0) {
      $status = $statusOutput | ConvertFrom-Json
      $ready = $status.health.ok -eq $true -and $status.health.agents -eq 3
    }
    if (-not $ready) { Start-Sleep -Seconds 2 }
  } while (-not $ready -and (Get-Date) -lt $readinessDeadline)
  if (-not $ready) { throw "Three release-review workers did not register within 90 seconds" }

$payload = [ordered]@{
  task = [ordered]@{
    id = "PI-EXT-22-RELEASE"
    summary = "Independently review the v0.4.3 provenance and quorum implementation. Read the current diff and validation evidence. Report security, compatibility, test, documentation, and release findings. Do not edit files, run destructive commands, commit, push, or change GitHub state. The coordinator must synthesize both replies, record any contradiction and decision, then pass the review checkpoint using workflowContext-bound evidenceRefs."
  }
} | ConvertTo-Json -Compress

  # A successful start is the exact-name readiness proof because the hub must
  # resolve the coordinator and both policy selectors before creating the run.
  $startResult = $null
  $startDeliveryId = "provenance-release-$([Guid]::NewGuid().ToString('N'))"
  $startDeadline = (Get-Date).AddSeconds(30)
  do {
    $startResult = & $nodeCommand $kxmScript `
      --json `
      --workspace .kxm `
      workflow start provenance-review `
      --payload $payload `
      --delivery-id $startDeliveryId 2>&1
    $started = $LASTEXITCODE -eq 0
    if (-not $started) { Start-Sleep -Seconds 2 }
  } while (-not $started -and (Get-Date) -lt $startDeadline)
  if (-not $started) { throw "Workflow target and peer selectors did not resolve within 30 seconds" }

  $startResult
  [pscustomobject]@{
    hubPid = $hub.Id
    workerPids = @($workers | ForEach-Object Id)
    kxmScript = $kxmScript
    project = $projectName
    credentialBoundary = "split-admin-project"
    providerRecovery = "settled-error-retain-and-fallback"
    toolPolicy = "read-only-reviewers-single-coordinator"
    toolTimeoutMs = 180000
    fanoutTimeoutMs = 120000
    extensionPaths = @($meshExtension, $providerExtension)
    skillPaths = @($meshSkill)
  } | ConvertTo-Json -Compress
} catch {
  if ($hub) {
    & $nodeCommand $kxmScript --json --workspace .kxm mesh stop | Out-Null
  }
  throw
}
