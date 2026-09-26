<!-- markdownlint-disable -->
# oh-my-pi 18.3.1 config.yml settings (extracted)

Extracted 2026-09-25 from `register()` calls under `@oh-my-pi/pi-coding-agent/src` (509 keys) by a scratch script; see `research-omp-config-schema.md` for the curated reference. Nested keys use dot paths, so `retry.maxRetries` is `retry:` then `maxRetries:` in YAML.

| key | type | values | default | env | source |
|---|---|---|---|---|---|
| `advisor.enabled` | boolean |  | false |  | advisor/settings.ts |
| `advisor.immuneTurns` | number |  | 3 |  | advisor/settings.ts |
| `advisor.maxNotesPerUpdate` | number |  | ADVISOR_DEFAULT_BUDGET_PER_UPDATE |  | advisor/settings.ts |
| `advisor.syncBacklog` | enum | off, 1, 3, 5 | "off" |  | advisor/settings.ts |
| `ask.enabled` | boolean |  | true |  | tools/settings.ts |
| `ask.notify` | enum | on, off | "on" |  | modes/settings.ts |
| `ask.timeout` | number |  | 0 |  | modes/settings.ts |
| `astEdit.enabled` | boolean |  | true |  | tools/settings.ts |
| `astGrep.enabled` | boolean |  | false |  | tools/settings.ts |
| `async.enabled` | boolean |  | true |  | tools/settings.ts |
| `async.maxJobs` | number |  | 100 |  | tools/settings.ts |
| `auth.accountPolicies` | array |  | EMPTY_AUTH_ACCOUNT_POLICIES |  | config/model-settings.ts |
| `auth.broker.token` | string (secret) |  | undefined | OMP_AUTH_BROKER_TOKEN | config/model-settings.ts |
| `auth.broker.url` | string |  | undefined | OMP_AUTH_BROKER_URL | config/model-settings.ts |
| `autocompleteMaxVisible` | number |  | 10 |  | modes/settings.ts |
| `autolearn.autoContinue` | boolean |  | false |  | autolearn/settings.ts |
| `autolearn.enabled` | boolean |  | false |  | autolearn/settings.ts |
| `autolearn.minToolCalls` | number |  |  |  | autolearn/settings.ts |
| `autoResume` | boolean |  | false |  | modes/settings.ts |
| `bash.allowCompoundCommands` | boolean |  | false |  | exec/settings.ts |
| `bash.autoBackground.enabled` | boolean |  | true |  | exec/settings.ts |
| `bash.autoBackground.thresholdMs` | number |  | 60_000 |  | exec/settings.ts |
| `bash.direnv` | enum | auto, off | "auto" |  | exec/settings.ts |
| `bash.direnvLoadTimeoutMs` | number |  | 30_000 |  | exec/settings.ts |
| `bash.enabled` | boolean |  | true |  | exec/settings.ts |
| `bash.patterns` | array |  | [] |  | exec/settings.ts |
| `bashInterceptor.enabled` | boolean |  | false |  | exec/settings.ts |
| `bashInterceptor.patterns` | array |  | DEFAULT_BASH_INTERCEPTOR_RULES |  | exec/settings.ts |
| `branchSummary.enabled` | boolean |  | false |  | session/context-settings.ts |
| `branchSummary.reserveTokens` | number |  | 16384 |  | session/context-settings.ts |
| `browser.cdpUrl` | string |  | undefined |  | tools/browser/settings.ts |
| `browser.cmux` | boolean |  | true |  | tools/browser/settings.ts |
| `browser.enabled` | boolean |  | true |  | tools/browser/settings.ts |
| `browser.freezeOnTurnEnd` | boolean |  | true |  | tools/browser/settings.ts |
| `browser.headless` | boolean |  | true |  | tools/browser/settings.ts |
| `browser.idleCloseSec` | number |  | 1800 |  | tools/browser/settings.ts |
| `browser.relay` | boolean |  | false |  | tools/browser/settings.ts |
| `browser.relayUrl` | string |  | undefined |  | tools/browser/settings.ts |
| `browser.screenshotDir` | string |  | undefined |  | tools/browser/settings.ts |
| `checkpoint.enabled` | boolean |  | false |  | tools/settings.ts |
| `claudeResets.autoRedeem` | enum | unset, yes, no | "unset" as const |  | session/settings.ts |
| `claudeResets.keepCredits` | number |  | 0 |  | session/settings.ts |
| `claudeResets.minBlockedMinutes` | number |  | 60 |  | session/settings.ts |
| `claudeResets.salvageHorizonHours` | number |  | 12 |  | session/settings.ts |
| `codexResets.autoRedeem` | enum | unset, yes, no | "unset" as const |  | session/settings.ts |
| `codexResets.keepCredits` | number |  | 0 |  | session/settings.ts |
| `codexResets.minBlockedMinutes` | number |  | 60 |  | session/settings.ts |
| `codexResets.salvageHorizonHours` | number |  | 12 |  | session/settings.ts |
| `collab.autoStart` | enum | off, view, control | "off" |  | collab/settings.ts |
| `collab.displayName` | string |  | "" |  | collab/settings.ts |
| `collab.relayUrl` | string |  | DEFAULT_RELAY_URL |  | collab/settings.ts |
| `collab.webUrl` | string |  | "" |  | collab/settings.ts |
| `colorBlindMode` | boolean |  | false |  | modes/settings.ts |
| `commands.enableClaudeProject` | boolean |  | true |  | extensibility/settings.ts |
| `commands.enableClaudeUser` | boolean |  | false |  | extensibility/settings.ts |
| `commands.enableOpencodeProject` | boolean |  | true |  | extensibility/settings.ts |
| `commands.enableOpencodeUser` | boolean |  | false |  | extensibility/settings.ts |
| `commit.cacheEnabled` | boolean |  |  |  | commit/settings.ts |
| `commit.cacheTtlDays` | number |  |  |  | commit/settings.ts |
| `commit.changelogMaxDiffChars` | number |  | 120000 |  | commit/settings.ts |
| `commit.mapBatchTokenBudget` | number |  | 16000 |  | commit/settings.ts |
| `commit.mapReduceEnabled` | boolean |  |  |  | commit/settings.ts |
| `commit.mapReduceThreshold` | number |  |  |  | commit/settings.ts |
| `compaction.asyncEnabled` | boolean |  | true |  | session/context-settings.ts |
| `compaction.autoContinue` | boolean |  |  |  | session/context-settings.ts |
| `compaction.dropUseless` | boolean |  | true |  | session/context-settings.ts |
| `compaction.enabled` | boolean |  | true |  | session/context-settings.ts |
| `compaction.experimentalContextManagement` | boolean |  | false |  | session/context-settings.ts |
| `compaction.handoffSaveToDisk` | boolean |  | false |  | session/context-settings.ts |
| `compaction.idleEnabled` | boolean |  | false |  | session/context-settings.ts |
| `compaction.idleThresholdTokens` | number |  | 200000 |  | session/context-settings.ts |
| `compaction.idleTimeoutSeconds` | number |  | 300 |  | session/context-settings.ts |
| `compaction.keepRecentTokens` | number |  | 20000 |  | session/context-settings.ts |
| `compaction.methodOrder` | array |  | [...DEFAULT_COMPACTION_METHOD_ORDER] |  | session/context-settings.ts |
| `compaction.midTurnEnabled` | boolean |  | true |  | session/context-settings.ts |
| `compaction.remoteEndpoint` | string |  | undefined |  | session/context-settings.ts |
| `compaction.remoteStreamingV2Enabled` | boolean |  | true |  | session/context-settings.ts |
| `compaction.reserveTokens` | number |  | undefined |  | session/context-settings.ts |
| `compaction.supersedeReads` | boolean |  | true |  | session/context-settings.ts |
| `compaction.thresholdPercent` | number |  | -1 |  | session/context-settings.ts |
| `compaction.thresholdTokens` | number |  | -1 |  | session/context-settings.ts |
| `compaction.v2RetainedMessageBudget` | number |  | 64000 |  | session/context-settings.ts |
| `completion.notify` | enum | on, off | "on" |  | modes/settings.ts |
| `composer.recallClearedDrafts` | boolean |  | true |  | modes/settings.ts |
| `composer.shape` | string |  | "band" |  | modes/settings.ts |
| `composer.tokenRate` | boolean |  | false |  | modes/settings.ts |
| `computer.display` | string |  | "all" |  | tools/settings.ts |
| `computer.enabled` | boolean |  | false |  | tools/settings.ts |
| `computer.maxHeight` | number |  | 2400 |  | tools/settings.ts |
| `computer.maxWidth` | number |  | 3840 |  | tools/settings.ts |
| `contextPromotion.enabled` | boolean |  | false |  | session/context-settings.ts |
| `cycleOrder` | array |  |  |  | config/model-settings.ts |
| `debug.enabled` | boolean |  | true |  | tools/settings.ts |
| `defaultThinkingLevel` | enum | ...THINKING_EFFORTS, AUTO_THINKING | "high" |  | session/settings.ts |
| `dev.autoqa` | boolean |  | true | PI_AUTO_QA | tools/settings.ts |
| `dev.autoqaConsent` | enum | unset, granted, denied | "unset" as const |  | tools/settings.ts |
| `dev.autoqaPush.endpoint` | string |  | "https://qa.omp.sh/v1/grievances" as const |  | tools/settings.ts |
| `dev.autoqaPush.token` | string (secret) |  | undefined |  | tools/settings.ts |
| `disabledExtensions` | array |  |  |  | extensibility/settings.ts |
| `disabledProviders` | array |  | EMPTY_STRING_ARRAY |  | config/model-settings.ts |
| `display.cacheMissMarker` | boolean |  | false |  | modes/settings.ts |
| `display.collapseCompacted` | boolean |  | true |  | modes/settings.ts |
| `display.hideToolActivity` | boolean |  | false |  | modes/settings.ts |
| `display.pinnedAgents` | enum | off, collapsed, full | "collapsed" |  | modes/settings.ts |
| `display.shimmer` | enum | classic, kitt, disabled | "classic" |  | modes/settings.ts |
| `display.showTokenUsage` | boolean |  | false |  | modes/settings.ts |
| `display.showTurnTime` | boolean |  | false |  | modes/settings.ts |
| `display.smoothStreaming` | boolean |  | true |  | modes/settings.ts |
| `doubleEscapeAction` | enum | rewind, tree, none | "rewind" |  | modes/settings.ts |
| `edit.autoRepair.enabled` | boolean |  | false |  | edit/settings.ts |
| `edit.blackbox.enabled` | boolean |  | false |  | edit/settings.ts |
| `edit.blockAutoGenerated` | boolean |  | true |  | edit/settings.ts |
| `edit.enforceSeenLines` | boolean |  | true |  | edit/settings.ts |
| `edit.fuzzyMatch` | boolean |  | true |  | edit/settings.ts |
| `edit.fuzzyThreshold` | number |  | 0.95 |  | edit/settings.ts |
| `edit.mode` | enum |  | "hashline" | PI_EDIT_VARIANT | edit/settings.ts |
| `edit.modelVariants` | record |  | EMPTY_STRING_RECORD |  | edit/settings.ts |
| `edit.recoverInlineEdits` | boolean |  | true |  | edit/settings.ts |
| `edit.streamingAbort` | boolean |  | false |  | edit/settings.ts |
| `emojiAutocomplete` | boolean |  | true |  | modes/settings.ts |
| `enabledModels` | array |  | EMPTY_STRING_ARRAY |  | config/model-settings.ts |
| `enabledProviders` | array |  | EMPTY_STRING_ARRAY |  | config/model-settings.ts |
| `error.notify` | enum | on, off | "off" |  | modes/settings.ts |
| `eval.autoBackground.enabled` | boolean |  | false |  | eval/settings.ts |
| `eval.autoBackground.thresholdMs` | number |  | 60_000 |  | eval/settings.ts |
| `eval.autoProvision` | boolean |  | true |  | eval/settings.ts |
| `eval.js` | boolean |  | true | PI_JS | eval/settings.ts |
| `eval.py` | boolean |  | true | PI_PY | eval/settings.ts |
| `eval.tools.enabled` | boolean |  | true |  | eval/settings.ts |
| `eval.workpool.freshAgents` | boolean |  | false |  | eval/settings.ts |
| `exa.enabled` | boolean |  | true |  | web/settings.ts |
| `exa.searchDelayMs` | number |  | 1_000 |  | web/settings.ts |
| `extendedContext` | boolean |  | false |  | session/context-settings.ts |
| `extensionHandlers.toolCallTimeoutMs` | number |  | 30_000 |  | extensibility/settings.ts |
| `extensions` | array |  |  |  | extensibility/settings.ts |
| `externalThinking` | boolean |  | false |  | session/settings.ts |
| `features.unexpectedStopDetection` | enum | none, mechanical, smart | "mechanical" |  | session/settings.ts |
| `fetch.enabled` | boolean |  | true |  | tools/settings.ts |
| `find.enabled` | enum | auto, on, off | "auto" |  | tools/settings.ts |
| `followUpMode` | enum | all, one-at-a-time | "one-at-a-time" |  | modes/settings.ts |
| `gc.archive` | boolean |  |  |  | cli/gc-settings.ts |
| `gc.blobs` | boolean |  |  |  | cli/gc-settings.ts |
| `gc.coldArchiveAfterDays` | number |  |  |  | cli/gc-settings.ts |
| `gc.retainNewestGlobal` | number |  |  |  | cli/gc-settings.ts |
| `gc.retainNewestPerCwd` | number |  |  |  | cli/gc-settings.ts |
| `gc.wal` | boolean |  |  |  | cli/gc-settings.ts |
| `generate_image.enabled` | boolean |  | false |  | tools/settings.ts |
| `git.enabled` | boolean |  | true |  | modes/settings.ts |
| `github.cache.enabled` | boolean |  | true |  | tools/settings.ts |
| `github.cache.hardTtlSec` | number |  | 604800 |  | tools/settings.ts |
| `github.cache.softTtlSec` | number |  | 300 |  | tools/settings.ts |
| `github.enabled` | boolean |  | false |  | tools/settings.ts |
| `glob.enabled` | boolean |  | true |  | tools/settings.ts |
| `goal.continuationModes` | array |  | ["interactive"] |  | goals/settings.ts |
| `goal.enabled` | boolean |  | true |  | goals/settings.ts |
| `goal.statusInFooter` | boolean |  | true |  | goals/settings.ts |
| `grep.contextAfter` | number |  | 3 |  | tools/settings.ts |
| `grep.contextBefore` | number |  | 1 |  | tools/settings.ts |
| `grep.enabled` | boolean |  | true |  | tools/settings.ts |
| `hideThinkingBlock` | boolean |  | false |  | session/settings.ts |
| `hindsight.apiToken` | string (secret) |  | undefined | HINDSIGHT_API_TOKEN | hindsight/settings.ts |
| `hindsight.apiUrl` | string |  | "http://localhost:8888" | HINDSIGHT_API_URL | hindsight/settings.ts |
| `hindsight.autoRecall` | boolean |  | true | HINDSIGHT_AUTO_RECALL | hindsight/settings.ts |
| `hindsight.autoRetain` | boolean |  | true | HINDSIGHT_AUTO_RETAIN | hindsight/settings.ts |
| `hindsight.bankId` | string |  | undefined | HINDSIGHT_BANK_ID | hindsight/settings.ts |
| `hindsight.bankIdPrefix` | string |  |  |  | hindsight/settings.ts |
| `hindsight.bankMission` | string |  | undefined | HINDSIGHT_BANK_MISSION | hindsight/settings.ts |
| `hindsight.debug` | boolean |  | false | HINDSIGHT_DEBUG | hindsight/settings.ts |
| `hindsight.mentalModelAutoSeed` | boolean |  | true |  | hindsight/settings.ts |
| `hindsight.mentalModelMaxRenderChars` | number |  | 16_000 |  | hindsight/settings.ts |
| `hindsight.mentalModelsEnabled` | boolean |  | true |  | hindsight/settings.ts |
| `hindsight.recallBudget` | enum | low, mid, high | "mid" | HINDSIGHT_RECALL_BUDGET | hindsight/settings.ts |
| `hindsight.recallContextTurns` | number |  | 1 |  | hindsight/settings.ts |
| `hindsight.recallMaxQueryChars` | number |  | 800 |  | hindsight/settings.ts |
| `hindsight.recallMaxTokens` | number |  | 1024 |  | hindsight/settings.ts |
| `hindsight.recallTimeoutMs` | number |  | 30_000 |  | hindsight/settings.ts |
| `hindsight.recallTypes` | array |  | HINDSIGHT_RECALL_TYPES_DEFAULT |  | hindsight/settings.ts |
| `hindsight.reflectTimeoutMs` | number |  | 120_000 |  | hindsight/settings.ts |
| `hindsight.requestTimeoutMs` | number |  | 30_000 |  | hindsight/settings.ts |
| `hindsight.retainContext` | string |  |  |  | hindsight/settings.ts |
| `hindsight.retainEveryNTurns` | number |  | 3 |  | hindsight/settings.ts |
| `hindsight.retainMission` | string |  | undefined |  | hindsight/settings.ts |
| `hindsight.retainMode` | enum | full-session, last-turn | "full-session" | HINDSIGHT_RETAIN_MODE | hindsight/settings.ts |
| `hindsight.retainOverlapTurns` | number |  | 2 |  | hindsight/settings.ts |
| `hindsight.retainTimeoutMs` | number |  | 60_000 |  | hindsight/settings.ts |
| `hindsight.scoping` | enum | global, per-project, per-project-tagged | "per-project-tagged" | HINDSIGHT_SCOPING | hindsight/settings.ts |
| `ida.enabled` | boolean |  | true |  | ida/settings.ts |
| `ida.idleCloseSec` | number |  | 900 |  | ida/settings.ts |
| `ida.installDir` | string |  | "" |  | ida/settings.ts |
| `ida.maxOpen` | number |  | 4 |  | ida/settings.ts |
| `ida.python` | string |  | "" |  | ida/settings.ts |
| `images.autoResize` | boolean |  | true |  | modes/settings.ts |
| `images.blockImages` | boolean |  | false |  | modes/settings.ts |
| `images.describeForTextModels` | boolean |  | true |  | session/settings.ts |
| `images.questionTimeoutMs` | number |  | 300_000 |  | tools/settings.ts |
| `images.urls.backends` | array |  | DEFAULT_IMAGES_URLS_BACKENDS |  | blob-broker/settings.ts |
| `images.urls.bindHost` | string |  | "127.0.0.1" |  | blob-broker/settings.ts |
| `images.urls.command` | string |  | undefined |  | blob-broker/settings.ts |
| `images.urls.credentials` | record (secret) |  | EMPTY_IMAGES_URLS_CREDENTIALS |  | blob-broker/settings.ts |
| `images.urls.enabled` | boolean |  | false |  | blob-broker/settings.ts |
| `images.urls.options` | record |  | EMPTY_IMAGES_URLS_OPTIONS |  | blob-broker/settings.ts |
| `images.urls.publicBaseUrl` | string |  | undefined |  | blob-broker/settings.ts |
| `images.urls.sshRemotePort` | number |  | 8787 |  | blob-broker/settings.ts |
| `images.urls.sshTarget` | string |  | undefined |  | blob-broker/settings.ts |
| `images.urls.ttlHours` | number |  | 72 |  | blob-broker/settings.ts |
| `includeModelInPrompt` | boolean |  | true |  | session/settings.ts |
| `includeWorkspaceTree` | boolean |  | false |  | session/settings.ts |
| `inlineToolDescriptors` | enum | auto, on, off | "auto" |  | session/settings.ts |
| `interruptMode` | enum | immediate, wait | "immediate" |  | modes/settings.ts |
| `isolation.backend` | enum | auto, apfs, btrfs, zfs, reflink, overlayfs, projfs, block-clone, rcopy | "auto" |  | task/settings.ts |
| `launch.enabled` | boolean |  | true |  | tools/settings.ts |
| `live.voice` | enum |  | DEFAULT_LIVE_VOICE |  | live/settings.ts |
| `loop.conditionTimeoutMs` | number |  | 30_000 |  | modes/settings.ts |
| `loop.mode` | enum | prompt, compact, reset | "prompt" |  | modes/settings.ts |
| `lsp.diagnosticsDeduplicate` | boolean |  | true |  | lsp/settings.ts |
| `lsp.diagnosticsOnEdit` | boolean |  | false |  | lsp/settings.ts |
| `lsp.diagnosticsOnWrite` | boolean |  |  |  | config/registry.ts |
| `lsp.diagnosticsOnWrite` | boolean |  | true |  | lsp/settings.ts |
| `lsp.enabled` | boolean |  | true |  | lsp/settings.ts |
| `lsp.formatOnWrite` | boolean |  | false |  | lsp/settings.ts |
| `lsp.lazy` | boolean |  | true |  | lsp/settings.ts |
| `lsp.shared` | boolean |  | true |  | lsp/settings.ts |
| `magicKeywords.enabled` | boolean |  | true |  | modes/settings.ts |
| `marketplace.autoUpdate` | enum | off, notify, auto | "notify" |  | modes/settings.ts |
| `mcp.enableProjectConfig` | boolean |  | true |  | mcp/settings.ts |
| `mcp.notificationDebounceMs` | number |  | 500 |  | mcp/settings.ts |
| `mcp.notifications` | boolean |  | false |  | mcp/settings.ts |
| `mcp.renderMarkdownResults` | boolean |  | true |  | mcp/settings.ts |
| `mcp.startupTimeoutMs` | number |  | 250 |  | mcp/settings.ts |
| `memories.enabled` | boolean |  | false |  | memories/settings.ts |
| `memories.fallbackTokenLimit` | number |  | 16000 |  | memories/settings.ts |
| `memories.maxRawMemoriesForGlobal` | number |  | 200 |  | memories/settings.ts |
| `memories.maxRolloutAgeDays` | number |  |  |  | memories/settings.ts |
| `memories.maxRolloutsPerStartup` | number |  | 64 |  | memories/settings.ts |
| `memories.minRolloutIdleHours` | number |  | 12 |  | memories/settings.ts |
| `memories.phase1InputTokenLimit` | number |  | 4000 |  | memories/settings.ts |
| `memories.phase2HeartbeatSeconds` | number |  | 30 |  | memories/settings.ts |
| `memories.phase2LeaseSeconds` | number |  | 180 |  | memories/settings.ts |
| `memories.phase2RetryDelaySeconds` | number |  | 180 |  | memories/settings.ts |
| `memories.rolloutPayloadPercent` | number |  | 0.7 |  | memories/settings.ts |
| `memories.stage1Concurrency` | number |  |  |  | memories/settings.ts |
| `memories.stage1LeaseSeconds` | number |  | 120 |  | memories/settings.ts |
| `memories.stage1RetryDelaySeconds` | number |  | 120 |  | memories/settings.ts |
| `memories.summaryInjectionTokenLimit` | number |  | 5000 |  | memories/settings.ts |
| `memories.threadScanLimit` | number |  |  |  | memories/settings.ts |
| `memory.backend` | enum | off, local, hindsight, mnemopi, sharpshooter | "off" |  | memory-backend/settings.ts |
| `minP` | number |  | -1 |  | session/settings.ts |
| `mnemopi.autoRecall` | boolean |  | true |  | mnemopi/settings.ts |
| `mnemopi.autoRetain` | boolean |  | true |  | mnemopi/settings.ts |
| `mnemopi.bank` | string |  | undefined |  | mnemopi/settings.ts |
| `mnemopi.dbPath` | string |  | undefined |  | mnemopi/settings.ts |
| `mnemopi.debug` | boolean |  |  |  | mnemopi/settings.ts |
| `mnemopi.embeddingApiKey` | string (secret) |  | undefined |  | mnemopi/settings.ts |
| `mnemopi.embeddingApiUrl` | string |  | undefined |  | mnemopi/settings.ts |
| `mnemopi.embeddingModel` | string |  | undefined |  | mnemopi/settings.ts |
| `mnemopi.embeddingVariant` | enum | en, multilingual | "en" |  | mnemopi/settings.ts |
| `mnemopi.enhancedRecall` | boolean |  | false |  | mnemopi/settings.ts |
| `mnemopi.injectionTokenLimit` | number |  | 5000 |  | mnemopi/settings.ts |
| `mnemopi.llmApiKey` | string (secret) |  | undefined |  | mnemopi/settings.ts |
| `mnemopi.llmBaseUrl` | string |  | undefined |  | mnemopi/settings.ts |
| `mnemopi.llmMode` | enum | none, smol, remote | "smol" |  | mnemopi/settings.ts |
| `mnemopi.llmModel` | string |  | undefined |  | mnemopi/settings.ts |
| `mnemopi.noEmbeddings` | boolean |  | false |  | mnemopi/settings.ts |
| `mnemopi.polyphonicRecall` | boolean |  | false |  | mnemopi/settings.ts |
| `mnemopi.proactiveLinking` | boolean |  | false |  | mnemopi/settings.ts |
| `mnemopi.recallContextTurns` | number |  |  |  | mnemopi/settings.ts |
| `mnemopi.recallLimit` | number |  |  |  | mnemopi/settings.ts |
| `mnemopi.recallMaxQueryChars` | number |  | 4000 |  | mnemopi/settings.ts |
| `mnemopi.retainEveryNTurns` | number |  |  |  | mnemopi/settings.ts |
| `mnemopi.scoping` | enum | global, per-project, per-project-tagged | "per-project" |  | mnemopi/settings.ts |
| `model.loopGuard.checkAssistantContent` | boolean |  | true |  | session/settings.ts |
| `model.loopGuard.enabled` | boolean |  | true |  | session/settings.ts |
| `model.loopGuard.toolCallReminder` | boolean |  | true |  | session/settings.ts |
| `model.toolCallLoopGuard.enabled` | boolean |  | true |  | session/settings.ts |
| `model.toolCallLoopGuard.exemptTools` | array |  | DEFAULT_TOOL_CALL_LOOP_EXEMPT_TOOLS |  | session/settings.ts |
| `model.toolCallLoopGuard.threshold` | number |  | 5 |  | session/settings.ts |
| `modelProviderOrder` | array |  |  |  | config/model-settings.ts |
| `modelRoles` | record |  |  |  | config/model-settings.ts |
| `modelRoleStorage` | enum | global, project | "global" |  | config/model-settings.ts |
| `modelTags` | record |  |  |  | config/model-settings.ts |
| `omitThinking` | boolean |  | false |  | session/settings.ts |
| `paste.largeMenuThreshold` | number |  | 100 |  | modes/settings.ts |
| `personality` | enum | default, friendly, pragmatic, none | "default" |  | session/settings.ts |
| `plan.autosave` | boolean |  | false |  | plan-mode/settings.ts |
| `plan.autosaveDir` | string |  | undefined |  | plan-mode/settings.ts |
| `plan.defaultOnStartup` | boolean |  | false |  | plan-mode/settings.ts |
| `plan.enabled` | boolean |  | true |  | plan-mode/settings.ts |
| `power.sleepPrevention` | enum | off, idle, display, system | "idle" |  | session/settings.ts |
| `presencePenalty` | number |  | -1 |  | session/settings.ts |
| `prewalk.enabled` | boolean |  | false |  | session/settings.ts |
| `proseOnlyThinking` | boolean |  | true |  | session/settings.ts |
| `provider.appendOnlyContext` | enum | auto, on, off | "auto" |  | session/settings.ts |
| `providers.anthropic.serverSideFallback` | boolean |  | false |  | session/settings.ts |
| `providers.anthropic.slowMode` | enum | off, auto | "off" as const |  | session/settings.ts |
| `providers.antigravityEndpoint` | enum | auto, production, sandbox | "auto" |  | session/settings.ts |
| `providers.autoThinkingMaxEffort` | enum | xhigh, max | "xhigh" |  | session/settings.ts |
| `providers.cacheRetention` | enum | auto, short, long, none | "auto" |  | session/settings.ts |
| `providers.fetch` | enum | auto, native, trafilatura, lynx, parallel, firecrawl, jina | "auto" |  | session/settings.ts |
| `providers.fireworksTier` | enum | standard, priority | "standard" |  | session/settings.ts |
| `providers.kimiApiFormat` | enum | auto, openai, anthropic | "auto" |  | session/settings.ts |
| `providers.maxInFlightRequests` | record |  | EMPTY_NUMBER_RECORD |  | session/settings.ts |
| `providers.ollama-cloud.maxConcurrency` | number |  | 3 |  | session/settings.ts |
| `providers.openai-codex.codeMode` | enum | off, on, auto | "off" |  | session/settings.ts |
| `providers.openai-codex.codeModeDirectTools` | array |  | EMPTY_STRING_ARRAY |  | session/settings.ts |
| `providers.openaiLiveSteering` | boolean |  | true |  | session/settings.ts |
| `providers.openaiWebsockets` | enum | auto, off, on | "auto" |  | session/settings.ts |
| `providers.openrouterVariant` | enum | default, nitro, floor, online, exacto | "default" |  | session/settings.ts |
| `providers.streamFirstEventTimeoutSeconds` | number |  | -1 |  | session/settings.ts |
| `providers.streamIdleTimeoutSeconds` | number |  | -1 |  | session/settings.ts |
| `providers.tinyModelDevice` | enum |  | TINY_MODEL_DEVICE_DEFAULT |  | session/settings.ts |
| `providers.tinyModelDtype` | enum |  | TINY_MODEL_DTYPE_DEFAULT |  | session/settings.ts |
| `providers.webSearchTimeoutSeconds` | number |  | DEFAULT_WEB_SEARCH_TIMEOUT_SECONDS |  | session/settings.ts |
| `python.interpreter` | string |  | "" |  | eval/settings.ts |
| `python.kernelMode` | enum | session, per-call | "session" |  | eval/settings.ts |
| `read.defaultLimit` | number |  | 300 |  | tools/settings.ts |
| `read.renderMarkdown` | boolean |  | false |  | tools/settings.ts |
| `read.summarize.enabled` | boolean |  | true |  | tools/settings.ts |
| `read.summarize.minBodyLines` | number |  | 4 |  | tools/settings.ts |
| `read.summarize.minCommentLines` | number |  | 6 |  | tools/settings.ts |
| `read.summarize.minTotalLines` | number |  | 100 |  | tools/settings.ts |
| `read.summarize.prose` | boolean |  | false |  | tools/settings.ts |
| `read.summarize.unfoldLimit` | number |  | 100 |  | tools/settings.ts |
| `read.summarize.unfoldUntil` | number |  | 50 |  | tools/settings.ts |
| `read.toolResultPreview` | boolean |  | false |  | tools/settings.ts |
| `readLineNumbers` | boolean |  | false |  | tools/settings.ts |
| `recap.enabled` | boolean |  | true |  | modes/settings.ts |
| `recap.idleSeconds` | number |  | 240 |  | modes/settings.ts |
| `repetitionPenalty` | number |  | -1 |  | session/settings.ts |
| `retry.baseDelayMs` | number |  |  |  | session/settings.ts |
| `retry.enabled` | boolean |  |  |  | session/settings.ts |
| `retry.fallbackChains` | record |  | EMPTY_STRING_ARRAYS_RECORD |  | session/settings.ts |
| `retry.fallbackRevertPolicy` | enum | cooldown-expiry, never | "cooldown-expiry" |  | session/settings.ts |
| `retry.maxDelayMs` | number |  | 5 * 60 * 1000 |  | session/settings.ts |
| `retry.maxRetries` | number |  | 10 |  | session/settings.ts |
| `retry.modelFallback` | boolean |  | true |  | session/settings.ts |
| `retry.usageAwareFallback` | boolean |  | false |  | session/settings.ts |
| `retry.usageReservePct` | number |  | DEFAULT_USAGE_RESERVE_PCT |  | session/settings.ts |
| `retry.usageReservePolicy` | enum | confirm, auto, fail-closed | "confirm" |  | session/settings.ts |
| `retry.waitForUsageReset` | boolean |  | false |  | session/settings.ts |
| `searxng.basicPassword` | string (secret) |  | undefined |  | web/settings.ts |
| `searxng.basicUsername` | string |  | undefined |  | web/settings.ts |
| `searxng.categories` | string |  |  |  | web/settings.ts |
| `searxng.endpoint` | string |  | undefined |  | web/settings.ts |
| `searxng.engines` | string |  |  |  | web/settings.ts |
| `searxng.language` | string |  |  |  | web/settings.ts |
| `searxng.safesearch` | number |  |  |  | web/settings.ts |
| `searxng.token` | string (secret) |  | undefined |  | web/settings.ts |
| `secrets.enabled` | boolean |  | false |  | secrets/settings.ts |
| `security.enabled` | boolean |  | false |  | tools/settings.ts |
| `setupVersion` | number |  |  |  | modes/settings.ts |
| `share.redactSecrets` | boolean |  | true |  | commands/settings.ts |
| `share.serverUrl` | string |  | DEFAULT_SHARE_URL |  | commands/settings.ts |
| `share.store` | enum | blob, gist | "blob" |  | commands/settings.ts |
| `sharpshooter.injectionTokenLimit` | number |  | 15000 |  | sharpshooter/settings.ts |
| `sharpshooter.intervalMinutes` | number |  | 5 |  | sharpshooter/settings.ts |
| `sharpshooter.model` | string |  | undefined |  | sharpshooter/settings.ts |
| `shellMinimizer.enabled` | boolean |  | true |  | exec/settings.ts |
| `shellMinimizer.except` | array |  | EMPTY_STRING_ARRAY |  | exec/settings.ts |
| `shellMinimizer.legacyFilters` | boolean |  | undefined |  | exec/settings.ts |
| `shellMinimizer.maxCaptureBytes` | number |  | 4 * 1024 * 1024 |  | exec/settings.ts |
| `shellMinimizer.only` | array |  | EMPTY_STRING_ARRAY |  | exec/settings.ts |
| `shellMinimizer.settingsPath` | string |  | undefined |  | exec/settings.ts |
| `shellMinimizer.sourceOutlineLevel` | enum | default, aggressive | "default" |  | exec/settings.ts |
| `shellPath` | string |  |  |  | exec/settings.ts |
| `showHardwareCursor` | boolean |  | true, // will be computed based on platform if undefined |  | modes/settings.ts |
| `skillful` | boolean |  | true |  | session/settings.ts |
| `skills.customDirectories` | array |  | EMPTY_STRING_ARRAY |  | extensibility/settings.ts |
| `skills.enableAgentsProject` | boolean |  | true |  | extensibility/settings.ts |
| `skills.enableAgentsUser` | boolean |  |  |  | extensibility/settings.ts |
| `skills.enableClaudeProject` | boolean |  | true |  | extensibility/settings.ts |
| `skills.enableClaudeUser` | boolean |  |  |  | extensibility/settings.ts |
| `skills.enableCodexUser` | boolean |  |  |  | extensibility/settings.ts |
| `skills.enabled` | boolean |  |  |  | extensibility/settings.ts |
| `skills.enablePiProject` | boolean |  |  |  | extensibility/settings.ts |
| `skills.enablePiUser` | boolean |  |  |  | extensibility/settings.ts |
| `skills.enableSkillCommands` | boolean |  | true |  | extensibility/settings.ts |
| `skills.ignoredSkills` | array |  | EMPTY_STRING_ARRAY |  | extensibility/settings.ts |
| `skills.includeSkills` | array |  | EMPTY_STRING_ARRAY |  | extensibility/settings.ts |
| `skills.registryUrl` | string |  | DEFAULT_SKILLS_URL |  | extensibility/settings.ts |
| `snapcompact.shape` | enum | auto, ...SHAPE_VARIANT_NAMES | "auto" |  | session/context-settings.ts |
| `snapcompact.systemPrompt` | enum | none, agents-md, all | "none" |  | session/context-settings.ts |
| `snapcompact.toolResults` | boolean |  | false |  | session/context-settings.ts |
| `speech.enabled` | boolean |  | false |  | tts/settings.ts |
| `speech.enhanced` | boolean |  | false |  | tts/settings.ts |
| `speech.mode` | enum | all, assistant, yield | "assistant" |  | tts/settings.ts |
| `speech.voice` | enum |  | DEFAULT_TTS_VOICE |  | tts/settings.ts |
| `speechgen.enabled` | boolean |  | false |  | tools/settings.ts |
| `spelling.autocomplete` | boolean |  | true |  | modes/settings.ts |
| `spelling.autocorrect` | boolean |  | false |  | modes/settings.ts |
| `spelling.typoDetection` | boolean |  | true |  | modes/settings.ts |
| `startup.changelogMode` | enum | summary, expanded, hidden | "summary" |  | modes/settings.ts |
| `startup.checkUpdate` | boolean |  | true |  | modes/settings.ts |
| `startup.quiet` | boolean |  | false |  | modes/settings.ts |
| `startup.setupWizard` | boolean |  | true |  | modes/settings.ts |
| `startup.showSplash` | boolean |  | false |  | modes/settings.ts |
| `statusLine.compactThinkingLevel` | boolean |  | true |  | modes/settings.ts |
| `statusLine.contextLine` | enum |  | "embedded" |  | modes/settings.ts |
| `statusLine.leftSegments` | array |  | CUSTOM_STATUS_LINE_DEFAULTS.left |  | modes/settings.ts |
| `statusLine.preset` | enum |  | "default" |  | modes/settings.ts |
| `statusLine.rightSegments` | array |  | CUSTOM_STATUS_LINE_DEFAULTS.right |  | modes/settings.ts |
| `statusLine.segmentOptions` | record |  | EMPTY_UNKNOWN_RECORD |  | modes/settings.ts |
| `statusLine.separator` | enum |  | "powerline-thin" |  | modes/settings.ts |
| `statusLine.sessionAccent` | boolean |  | true |  | modes/settings.ts |
| `statusLine.showHookStatus` | boolean |  | true |  | modes/settings.ts |
| `statusLine.transparent` | boolean |  | false |  | modes/settings.ts |
| `steeringMode` | enum | all, one-at-a-time | "one-at-a-time" |  | modes/settings.ts |
| `stream.redactPatterns` | array |  | EMPTY_STRING_ARRAY |  | stream/settings.ts |
| `stream.serverUrl` | string |  | DEFAULT_STREAM_URL |  | stream/settings.ts |
| `stt.enabled` | boolean |  | false |  | stt/settings.ts |
| `stt.language` | string |  |  |  | stt/settings.ts |
| `stt.submitTrigger` | enum |  | "never" |  | stt/settings.ts |
| `symbolPreset` | enum | unicode, nerd, ascii | "unicode" |  | modes/settings.ts |
| `task.agentAdvisor` | record |  | {} as Record<string, string> |  | task/settings.ts |
| `task.agentCompactionThresholdOverrides` | record |  | EMPTY_AGENT_COMPACTION_THRESHOLD_OVERRIDES |  | task/settings.ts |
| `task.agentIdleTtlMs` | number |  | 420_000 |  | task/settings.ts |
| `task.agentModelOverrides` | record |  | DEFAULT_AGENT_MODEL_OVERRIDES |  | task/settings.ts |
| `task.agentPrewalk` | record |  | {} as Record<string, string> |  | task/settings.ts |
| `task.agentServiceTierOverrides` | record |  | EMPTY_AGENT_SERVICE_TIER_OVERRIDES |  | task/settings.ts |
| `task.batch` | boolean |  | true |  | task/settings.ts |
| `task.disabledAgents` | array |  | [] as string[] |  | task/settings.ts |
| `task.eager` | enum | default, preferred, always | "default" |  | task/settings.ts |
| `task.enableEffort` | boolean |  | false |  | task/settings.ts |
| `task.enableLsp` | boolean |  | false |  | task/settings.ts |
| `task.isolation.apply` | boolean |  | true |  | task/settings.ts |
| `task.isolation.commits` | enum | generic, ai | "generic" |  | task/settings.ts |
| `task.isolation.enabled` | boolean |  | false |  | task/settings.ts |
| `task.isolation.merge` | enum | patch, branch | "patch" |  | task/settings.ts |
| `task.maxConcurrency` | number |  | 32 |  | task/settings.ts |
| `task.maxEffort` | enum |  | "max" |  | task/settings.ts |
| `task.maxRecursionDepth` | number |  | 2 |  | task/settings.ts |
| `task.maxRuntimeMs` | number |  | 0 |  | task/settings.ts |
| `task.prewalk` | boolean |  | false |  | task/settings.ts |
| `task.showResolvedModelBadge` | boolean |  | false |  | task/settings.ts |
| `task.softRequestBudget` | number |  | 200 |  | task/settings.ts |
| `task.softRequestBudgetNotice` | boolean |  | true |  | task/settings.ts |
| `tasks.todoClearDelay` | number |  | 60 |  | tools/settings.ts |
| `temperature` | number |  | -1 |  | session/settings.ts |
| `terminal.showImages` | boolean |  | true |  | modes/settings.ts |
| `terminal.showProgress` | boolean |  | false |  | modes/settings.ts |
| `textVerbosity` | enum | low, medium, high | "medium" |  | session/settings.ts |
| `theme.dark` | string |  | "titanium" |  | modes/settings.ts |
| `theme.light` | string |  | "light" |  | modes/settings.ts |
| `thinkingBudgets.high` | number |  |  |  | session/settings.ts |
| `thinkingBudgets.low` | number |  |  |  | session/settings.ts |
| `thinkingBudgets.max` | number |  |  |  | session/settings.ts |
| `thinkingBudgets.medium` | number |  |  |  | session/settings.ts |
| `thinkingBudgets.minimal` | number |  |  |  | session/settings.ts |
| `thinkingBudgets.xhigh` | number |  |  |  | session/settings.ts |
| `tier.advisor` | enum |  | "none" |  | session/settings.ts |
| `tier.anthropic` | enum |  | "none" |  | session/settings.ts |
| `tier.google` | enum |  | "none" |  | session/settings.ts |
| `tier.openai` | enum |  | "none" |  | session/settings.ts |
| `tier.subagent` | enum |  | "inherit" |  | session/settings.ts |
| `title.refreshOnReplan` | boolean |  | true |  | goals/settings.ts |
| `todo.eager` | enum | default, preferred, always | "default" |  | tools/settings.ts |
| `todo.enabled` | boolean |  | true |  | tools/settings.ts |
| `todo.reminders` | boolean |  | true |  | tools/settings.ts |
| `todo.remindersMax` | number |  | 3 |  | tools/settings.ts |
| `tools.abortOnFabricatedResult` | boolean |  | true |  | tools/settings.ts |
| `tools.approval` | record |  | {} |  | tools/settings.ts |
| `tools.approvalMode` | enum | always-ask, write, yolo | "yolo" |  | tools/settings.ts |
| `tools.artifactHeadBytes` | number |  | 20 |  | tools/settings.ts |
| `tools.artifactSpillThreshold` | number |  | 50 |  | tools/settings.ts |
| `tools.artifactTailBytes` | number |  | 20 |  | tools/settings.ts |
| `tools.artifactTailLines` | number |  | 500 |  | tools/settings.ts |
| `tools.format` | enum | auto, native, glm, hermes, kimi, xml, anthropic, deepseek, harmony, qwen3, gemini, gemma, minimax, | "auto" |  | session/context-settings.ts |
| `tools.intentTracing` | boolean |  | true | PI_INTENT_TRACING | tools/settings.ts |
| `tools.maxTimeout` | number |  | 0 |  | tools/settings.ts |
| `tools.outputMaxColumns` | number |  | 768 |  | tools/settings.ts |
| `tools.speculativeExecution.enabled` | boolean |  | false |  | tools/settings.ts |
| `tools.speculativeExecution.maxInFlight` | number |  | 2 |  | tools/settings.ts |
| `tools.xdev` | boolean |  | true |  | tools/settings.ts |
| `tools.xdevDocs` | enum | inline, builtins, catalog | "catalog" |  | tools/settings.ts |
| `tools.xdevInlineDevices` | array |  | EMPTY_STRING_ARRAY |  | tools/settings.ts |
| `topK` | number |  | -1 |  | session/settings.ts |
| `topP` | number |  | -1 |  | session/settings.ts |
| `treeFilterMode` | enum |  | "default" |  | modes/settings.ts |
| `tts.localVoice` | enum |  | DEFAULT_TTS_VOICE |  | tts/settings.ts |
| `ttsr.builtinRules` | boolean |  | true |  | export/ttsr-settings.ts |
| `ttsr.contextMode` | enum | discard, keep | "discard" |  | export/ttsr-settings.ts |
| `ttsr.disabledRules` | array |  | [] as string[] |  | export/ttsr-settings.ts |
| `ttsr.enabled` | boolean |  | true |  | export/ttsr-settings.ts |
| `ttsr.interruptMode` | enum | never, prose-only, tool-only, always | "always" |  | export/ttsr-settings.ts |
| `ttsr.judge` | enum | auto, on, off | "auto" |  | export/ttsr-settings.ts |
| `ttsr.repeatGap` | number |  | 10 |  | export/ttsr-settings.ts |
| `ttsr.repeatMode` | enum | once, after-gap | "once" |  | export/ttsr-settings.ts |
| `tui.codexResetFireworks` | boolean |  | false |  | modes/settings.ts |
| `tui.hyperlinks` | enum | off, auto, always | "auto" |  | modes/settings.ts |
| `tui.imeSafeCursor` | boolean |  | false |  | modes/settings.ts |
| `tui.maxInlineImageColumns` | number |  | 100 |  | modes/settings.ts |
| `tui.maxInlineImageRows` | number |  | 20 |  | modes/settings.ts |
| `tui.maxInlineImages` | number |  | 8 |  | modes/settings.ts |
| `tui.mouse` | boolean |  | false |  | modes/settings.ts |
| `tui.reactions` | boolean |  | true |  | modes/settings.ts |
| `tui.renderMermaid` | boolean |  | true |  | modes/settings.ts |
| `tui.resizeScrollback` | enum | append, rebuild, preserve | "rebuild" |  | modes/settings.ts |
| `tui.textSizing` | boolean |  | false |  | modes/settings.ts |
| `tui.tight` | boolean |  | false |  | modes/settings.ts |
| `tui.titleSpinner` | enum | braille, pulse, dots, line | "braille" |  | modes/settings.ts |
| `tui.titleState` | boolean |  | true |  | modes/settings.ts |
| `tui.vimMode` | boolean |  | false |  | modes/settings.ts |
| `tui.vimModeDisplay` | enum | text, icon, none | "text" |  | modes/settings.ts |
| `update.channel` | enum | stable, canary | "stable" |  | modes/settings.ts |
| `vault.enabled` | boolean |  | false |  | tools/settings.ts |
| `web_search.enabled` | boolean |  | true |  | tools/settings.ts |
| `workspace.additionalDirectories` | array |  | EMPTY_STRING_ARRAY |  | session/context-settings.ts |
| `worktree.base` | string |  | undefined |  | task/settings.ts |
| `worktree.cleanSource` | boolean |  | false |  | task/settings.ts |
| `worktree.clone` | boolean |  | true |  | task/settings.ts |

## Descriptions

- `advisor.enabled`: Pair a second model (assigned to the 'advisor' role) that passively reviews each turn and injects notes.
- `advisor.immuneTurns`: After an advisor concern or blocker interrupts, route further concerns/blockers non-interruptingly for this many primary turns.
- `advisor.maxNotesPerUpdate`: Maximum non-blocker advice notes accepted per advisor prompt update (1–32; UI offers 1–5 quick picks). Blockers are exempt.
- `advisor.syncBacklog`: Pause the main agent for up to 30 seconds if the advisor falls behind by this many turns. Off disables catch-up delays.
- `ask.enabled`: Enable the ask tool for interactive user questions
- `ask.notify`: Notify when the ask tool is waiting for input
- `ask.timeout`: Auto-select the recommended ask option after this many seconds (0 disables)
- `astEdit.enabled`: Enable the ast_edit tool for structural AST rewrites
- `astGrep.enabled`: Enable the ast_grep tool for structural AST search
- `async.enabled`: Enable async bash commands and background task execution
- `autocompleteMaxVisible`: Max visible items in autocomplete dropdown (3-20)
- `autolearn.autoContinue`: When on, auto-run one private capture turn at stop (uses extra tokens). When off, only standing auto-learn guidance remains.
- `autolearn.enabled`: After the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills
- `autoResume`: Automatically resume the most recent session in the current directory
- `bash.allowCompoundCommands`: Evaluate literal && chains per command; unmatched commands use normal bash approval policy and mode
- `bash.autoBackground.enabled`: Automatically background long-running bash commands and deliver the result later
- `bash.direnv`: Auto-load a repo's direnv/devenv `.envrc` into the bash session so devenv tools and env vars are present without manual `direnv exec`. Honors direnv's allow list: an `.envrc` you haven't `direnv allow`ed is never executed
- `bash.direnvLoadTimeoutMs`: Max wait for the first `direnv export` (a cold devenv shell can be slow); on timeout the session runs without the direnv env
- `bash.enabled`: Enable the bash tool for shell command execution
- `bash.patterns`: Ordered bash command approval rules. Each item has match and approval fields; only '*' wildcards are supported.
- `bashInterceptor.enabled`: Block shell commands that have dedicated tools
- `branchSummary.enabled`: Prompt to summarize when leaving a branch
- `browser.cdpUrl`: Default HTTP CDP discovery endpoint (for example http://127.0.0.1:9222) to attach to instead of launching a browser. Explicit app.cdp_url or app.path on the tool call take precedence.
- `browser.cmux`: Use cmux WKWebView surfaces for browser automation when a cmux socket is available. Set PI_BROWSER_CMUX=0 or PI_BROWSER_CMUX=1 to override.
- `browser.enabled`: Enable the browser eval prelude for scripted Chromium automation (Puppeteer)
- `browser.freezeOnTurnEnd`: Freeze OMP-owned headless browser tabs when a turn settles so animated pages stop burning CPU/GPU while idle. Tabs unfreeze automatically on next use; pass persist:true on open to opt a tab out.
- `browser.headless`: Launch browser in headless mode (disable to show browser UI)
- `browser.idleCloseSec`: Close OMP-owned headless browser tabs idle longer than this many seconds (0 = never; session dispose still reaps). Applies only to OMP-launched headless tabs, never relay/CDP/spawned browsers or other sessions' tabs.
- `browser.relay`: Drive your own Chrome tabs through the omp browser relay. Install the extension once (`omp browser-relay install`); the relay server auto-starts when the browser prelude needs it. Takes precedence over Browser CDP URL; set PI_BROWSER_RELAY=0 or PI_BROWSER_RELAY=1 to override.
- `browser.relayUrl`: omp browser relay endpoint (default http://127.0.0.1:9224).
- `browser.screenshotDir`: Directory to save screenshots. If unset, screenshots go to a temp file. Supports ~. Examples: ~/Downloads, ~/Desktop, /sdcard/Download (Android)
- `checkpoint.enabled`: Enable the checkpoint and rewind tools for context checkpointing
- `claudeResets.autoRedeem`: Spend eligible Claude Cedar or Juniper resets automatically. Cedar is spent only for covered limits; Juniper can only recover a sole 5-hour block. unset asks before the first spend, yes spends without prompting, and no disables blocked recovery and expiry salvage.
- `claudeResets.keepCredits`: Keep at least this many Claude resets banked (0 allows the last eligible reset to be spent automatically). The reserve also applies to expiry salvage.
- `claudeResets.minBlockedMinutes`: Only auto-redeem when the natural unblock — the latest reset among the exhausted covered windows — is at least this many minutes away. A 5-hour-only reset is never used for a weekly or model-scoped block.
- `claudeResets.salvageHorizonHours`: Use a server-selected Cedar reset within this many hours of expiry only when its covered windows have meaningful usage to restore and the grant permits early use or a covered window is exhausted (0 disables salvage).
- `codexResets.autoRedeem`: Spend saved Codex rate-limit resets automatically: restore an account blocked by an exhausted 5h or weekly window when a turn is stuck and no other account can take over, and salvage credits that are about to expire. unset asks before the first spend, yes spends without prompting, and no disables both checks.
- `codexResets.keepCredits`: Never auto-spend below this many saved resets (0 = the last credit may be spent automatically). Credits about to expire are exempt — a reserved credit that expires preserves nothing.
- `codexResets.minBlockedMinutes`: Only auto-redeem when the natural unblock — the latest reset among the exhausted 5h/weekly windows — is at least this many minutes away (don't spend a scarce credit to save a short wait). Raise it (e.g. 360) to ignore 5h-only blocks.
- `codexResets.salvageHorizonHours`: Spend a saved Codex reset automatically when it would otherwise expire within this many hours and either chat window (5h or weekly) has meaningful usage to restore (0 disables expiry salvage).
- `collab.autoStart`: Host every interactive session via collab.relayUrl as it starts and publish it to the local registry (omp collab list); rooms rotate on session switch
- `collab.displayName`: Name shown to other collab participants (default: OS username)
- `collab.relayUrl`: Relay used by /collab (wss://host[:port])
- `collab.webUrl`: Browser UI used by /collab links; empty derives from collab.relayUrl; explicit http:// is localhost-only
- `colorBlindMode`: Use blue instead of green for diff additions
- `commands.enableClaudeProject`: Load commands from .claude/commands/
- `commands.enableClaudeUser`: Load commands from ~/.claude/commands/
- `commands.enableOpencodeProject`: Load commands from .opencode/commands/
- `commands.enableOpencodeUser`: Load commands from ~/.config/opencode/commands/
- `compaction.asyncEnabled`: Speculatively summarize in the background as context nears the compaction threshold, then splice the ready result in when the threshold is crossed
- `compaction.dropUseless`: Prune tool results flagged contextually useless (no matches, timed-out waits) once consumed (cache-aware)
- `compaction.enabled`: Automatically compact context when it gets too large
- `compaction.experimentalContextManagement`: Keep persistent notes and searchable raw history across context windows.
- `compaction.handoffSaveToDisk`: Save generated handoff documents to markdown files for the auto-handoff flow
- `compaction.idleEnabled`: Compact context while idle when token count exceeds threshold
- `compaction.idleThresholdTokens`: Token count above which idle compaction triggers
- `compaction.idleTimeoutSeconds`: Seconds to wait while idle before compacting
- `compaction.methodOrder`: Preferred fallback order for automatic context maintenance; unavailable or failed methods advance to the next choice
- `compaction.midTurnEnabled`: Check thresholds at safe mid-turn tool-loop boundaries before the next provider request
- `compaction.remoteStreamingV2Enabled`: Use Responses streaming compaction for compatible remote compaction models
- `compaction.supersedeReads`: Prune older read results when the same file is read again (cache-aware, runs every turn)
- `compaction.thresholdPercent`: Percent threshold for context maintenance; set to Default to use legacy reserve-based behavior
- `compaction.thresholdTokens`: Fixed token limit for context maintenance; overrides percentage if set
- `completion.notify`: Notify when the agent finishes a turn
- `composer.recallClearedDrafts`: Keep drafts cleared with Ctrl+C in local Up/Down history until exit; disabling affects future clears
- `composer.shape`: Visual layout of the input editor and status line
- `composer.tokenRate`: Show a live generation tok/s readout on the working row, docked right next to the session title. Estimated from streamed deltas and corrected by the provider's billed output count as each message completes.
- `computer.display`: Composite all displays or select a native display id
- `computer.enabled`: Enable the scriptable host-desktop eval prelude (screenshots, input, accessibility)
- `computer.maxHeight`: Maximum composite screenshot height in pixels
- `computer.maxWidth`: Maximum composite screenshot width in pixels
- `contextPromotion.enabled`: Promote to a larger-context model on context overflow instead of compacting
- `debug.enabled`: Enable the debug tool for DAP-based debugging
- `defaultThinkingLevel`: Reasoning depth for thinking-capable models
- `dev.autoqa`: Automated tool issue reporting (xd://report_issue). On by default; the first report asks for consent, and denying it disables reporting until re-enabled explicitly
- `dev.autoqaPush.endpoint`: Full URL receiving Auto QA JSON reports (default https://qa.omp.sh/v1/grievances)
- `display.cacheMissMarker`: Show a divider after an assistant turn whose request lost (missed) the prompt cache
- `display.collapseCompacted`: Collapse pre-compaction history behind the summary divider on the live transcript; disable to keep the full transcript inline with dividers at each compaction point
- `display.hideToolActivity`: Hide model-initiated tool calls and results from the transcript
- `display.pinnedAgents`: Pinned live-agent jump list above the editor (off hides it; collapsed shows a few rows with an expander; full lists all)
- `display.shimmer`: Animation style for working/loading messages
- `display.showTokenUsage`: Show per-turn token usage on assistant messages
- `display.showTurnTime`: Show the total prompt-to-yield time (including tool calls) on assistant message usage rows
- `display.smoothStreaming`: Reveal assistant text and streamed tool input smoothly while chunks arrive
- `doubleEscapeAction`: What pressing Escape twice with an empty editor does: open the transcript rewind selector, open the session tree, or nothing
- `edit.autoRepair.enabled`: When an edit breaks a file's AST parse, ask the smol model to fix the broken region (validated by re-parse; falls back to a warning)
- `edit.blackbox.enabled`: Append full before/after source when an edit introduces an AST parse failure
- `edit.blockAutoGenerated`: Prevent editing of files that appear to be auto-generated (protoc, sqlc, swagger, etc.)
- `edit.enforceSeenLines`: Reject edits anchored on lines a prior read/search never displayed in full
- `edit.fuzzyMatch`: Accept high-confidence fuzzy matches for whitespace differences
- `edit.fuzzyThreshold`: Similarity threshold (0-1) for accepting fuzzy matches
- `edit.mode`: Select the edit tool variant (replace, patch, hashline, or apply_patch)
- `edit.recoverInlineEdits`: Execute edit payloads the model emits as plain text by converting them into edit tool calls
- `edit.streamingAbort`: Abort streaming edit tool calls when patch preview fails
- `emojiAutocomplete`: Suggest emojis from `:name:` shortcodes and expand text emoticons like `:D` or `:-)`
- `error.notify`: Notify when the agent stops with an error
- `eval.autoBackground.enabled`: Automatically background long-running eval cells and deliver the result later
- `eval.autoProvision`: Automatically create the managed JavaScript eval package environment on first install
- `eval.js`: Allow the eval tool to dispatch JavaScript cells to the in-process runtime
- `eval.py`: Allow the eval tool to dispatch Python cells to the IPython kernel
- `eval.tools.enabled`: Let eval cells define tools (@tool in Python, tool(fn) in JS) that task, agent(), and workpool() subagents can call
- `eval.workpool.freshAgents`: Spawn a new subagent for every workpool item instead of reusing workers or batching queued items
- `exa.enabled`: Enable the Exa web search provider
- `exa.searchDelayMs`: Minimum delay between Exa web search requests in milliseconds; set 0 to disable pacing
- `extendedContext`: Use larger context windows where supported; may incur premium pricing. Off keeps default or standard-pricing windows
- `extensionHandlers.toolCallTimeoutMs`: Positive finite active-work timeout for extension tool_call handlers; invalid values use 30000ms, and time awaiting OMP-owned dialogs does not count
- `externalThinking`: Private scratchpad; not shown to user. Disables supported GPT, Claude, and Gemini reasoning
- `features.unexpectedStopDetection`: Automatically recover when the assistant stops without a visible message. Smart also classifies text-only stops with a small model.
- `fetch.enabled`: Allow the read tool to fetch and process URLs
- `find.enabled`: Enable the find tool: natural-language search for files and line ranges, judged by the judge model role. Auto enables it only when the judge role resolves to a native TypeSafe jev model
- `followUpMode`: How to drain follow-up messages after a turn completes
- `generate_image.enabled`: Enable the generate_image tool (text-to-image generation and editing). Exposed as an xd:// device when tools.xdev is on.
- `git.enabled`: Show git branch, status, and PR information in the TUI and watch repository metadata.
- `github.cache.enabled`: Cache rendered issue/PR view output in ~/.omp/cache/github-cache.db so repeated reads are free
- `github.cache.hardTtlSec`: Past the soft TTL the cached row is returned and refreshed in the background; past the hard TTL it is dropped (seconds; default 7 days)
- `github.cache.softTtlSec`: Within this window, cached issue/PR view rows are returned directly (seconds; default 5 minutes)
- `github.enabled`: Enable the github tool (op-based dispatch for repository, issue, pull request, diff, search, checkout, push, and Actions watch workflows)
- `glob.enabled`: Enable the glob tool for glob-based file lookup
- `goal.continuationModes`: Run modes where active goals may auto-continue between turns
- `goal.enabled`: Enable per-session goal mode and the hidden goal tool
- `goal.statusInFooter`: Show token budget alongside the goal indicator in the status line
- `grep.contextAfter`: Lines of context after each grep match
- `grep.contextBefore`: Lines of context before each grep match
- `grep.enabled`: Enable the grep tool for regex content search
- `hideThinkingBlock`: Hide thinking blocks in assistant responses
- `hindsight.apiToken`: Bearer token for authenticated Hindsight servers
- `hindsight.apiUrl`: Hindsight server URL (Cloud or self-hosted)
- `hindsight.autoRecall`: Recall memories on the first turn of each session
- `hindsight.autoRetain`: Retain transcript every N turns and at session boundaries
- `hindsight.bankId`: Memory bank identifier (default: project name)
- `hindsight.mentalModelAutoSeed`: At session start, create any built-in mental models (project-conventions, project-decisions, user-preferences) that do not yet exist on the bank.
- `hindsight.mentalModelsEnabled`: Read curated reflect summaries (mental models) into developer instructions at boot. Loads existing models on the bank — does not write. Pair with hindsight.mentalModelAutoSeed to also auto-create the built-in seed set.
- `hindsight.retainMode`: full-session = upsert one document per session, last-turn = chunked
- `hindsight.scoping`: global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = shared bank with project tags so global + project memories merge on recall
- `ida.enabled`: Open executables read with `read` in IDA Pro (idalib) and enable the `ida` tool; inert when no IDA install is found
- `ida.idleCloseSec`: Save and close IDA databases idle longer than this many seconds (0 = never); the exec namespace resets on reopen
- `ida.installDir`: Directory containing libidalib, exported as IDADIR; empty auto-detects ($IDADIR, ida-config.json, standard install paths)
- `ida.maxOpen`: Most IDA databases (omp.ida.* daemons in omp ps) open at once per project; opening another saves and closes the least recently used idle one
- `ida.python`: Python interpreter that can import ida_domain and idapro; empty auto-detects
- `images.autoResize`: Resize large images to 2000x2000 max for better model compatibility
- `images.blockImages`: Prevent images from being sent to LLM providers
- `images.describeForTextModels`: When an image is attached to a model without vision support, save it under local:// and inject a description from a vision-capable model instead of dropping it
- `images.questionTimeoutMs`: Per-request timeout for the vision-model call behind read's ?q= image questions, in milliseconds. A stalled provider fails fast with a timeout error instead of blocking until manual abort. Set to 0 to disable the timeout.
- `images.urls.backends`: Ordered destinations tried when publishing images for provider access
- `images.urls.bindHost`: Host the blob server binds to; loopback for tunnels, 0.0.0.0 for direct serving
- `images.urls.command`: Argv template for the command backend; {file} is the image path, {mime}/{ext} optional. The last URL printed on stdout is used (e.g. pasta -b -f {file})
- `images.urls.enabled`: Publish outgoing images through the configured backend chain and send URL-fetching providers short URLs instead of inline base64. Falls back to inline automatically when every backend or a provider fetch fails
- `images.urls.publicBaseUrl`: Externally reachable base URL fronting the blob server (required for ssh, optional for direct)
- `images.urls.sshRemotePort`: Remote listen port of the ssh reverse forward that your web server proxies to
- `images.urls.sshTarget`: user@host destination for the ssh reverse forward
- `images.urls.ttlHours`: Serving window for locally hosted image URLs, measured from the last time a conversation sent them; resuming a conversation re-arms the window at the same link. 0 keeps links alive while the broker runs
- `includeModelInPrompt`: Surface the active model identifier in the system prompt so the agent knows which model it is
- `includeWorkspaceTree`: Render the workspace directory tree in the system prompt. WARNING: This can bust prompt caching across sessions when files are modified.
- `inlineToolDescriptors`: Render full tool descriptors in the system prompt and strip top-level/nested descriptions from provider tool schemas so descriptor text is sent once. Auto enables this for Gemini models and disables it otherwise
- `interruptMode`: When steering messages interrupt tool execution
- `isolation.backend`: Backend used for subagent isolation and worktree cloning
- `launch.enabled`: Enable named bash services and proc:// supervision for shared long-running project processes
- `live.voice`: Voice used by Codex-backed realtime voice sessions
- `loop.conditionTimeoutMs`: Max wait for a `/loop --while` / `--until` condition command before treating it as broken and stopping the loop. Set to 0 to wait indefinitely
- `loop.mode`: What happens between /loop iterations before re-submitting the prompt
- `lsp.diagnosticsDeduplicate`: Suppress post-edit LSP diagnostics already shown for a file; only surface new or changed ones
- `lsp.diagnosticsOnEdit`: Return LSP diagnostics after editing code files
- `lsp.diagnosticsOnWrite`: …
- `lsp.diagnosticsOnWrite`: Return LSP diagnostics after writing code files
- `lsp.enabled`: Enable the lsp tool for code intelligence (definitions, references, diagnostics, rename)
- `lsp.formatOnWrite`: Automatically format code files using LSP after writing
- `lsp.lazy`: Start language servers on first use (lsp tool or editing a matching file type) instead of at session startup
- `lsp.shared`: Share one language server per project across omp instances via the daemon broker (falls back to private servers when unavailable)
- `marketplace.autoUpdate`: Check for plugin updates on startup
- `mcp.enableProjectConfig`: Load .mcp.json/mcp.json from project root
- `mcp.notificationDebounceMs`: Debounce window in milliseconds for MCP resource updates before injecting them into the conversation
- `mcp.notifications`: Inject MCP resource updates into the agent conversation
- `mcp.renderMarkdownResults`: Render non-JSON MCP text results as Markdown in the transcript
- `mcp.startupTimeoutMs`: Wait this many milliseconds for initial MCP tool discovery; 0 waits until connections settle
- `memory.backend`: Off, local summary pipeline, Mnemopi SQLite, Hindsight remote memory, or Sharpshooter
- `minP`: Minimum probability threshold (0-1, -1 = provider default)
- `mnemopi.autoRecall`: Recall local memories into the first turn of each session
- `mnemopi.autoRetain`: Retain completed conversation turns into local Mnemopi memory
- `mnemopi.bank`: Optional shared bank base name. Per-project modes derive project-local banks from it.
- `mnemopi.dbPath`: Optional SQLite DB path. Defaults to the agent memories directory.
- `mnemopi.embeddingApiKey`: Optional embedding API key passed to Mnemopi
- `mnemopi.embeddingApiUrl`: Optional OpenAI-compatible embedding endpoint passed to Mnemopi
- `mnemopi.embeddingModel`: Advanced: explicit embedding model id that overrides the variant. Leave empty to use mnemopi.embeddingVariant.
- `mnemopi.embeddingVariant`: Local embedding model family. en = stronger English model; multilingual = cross-language model. Changing this rebuilds existing memory embeddings on next start.
- `mnemopi.enhancedRecall`: Enable the tiered query result cache for repeated and similar recall queries
- `mnemopi.llmApiKey`: Optional LLM API key for Mnemopi remote mode
- `mnemopi.llmBaseUrl`: Optional OpenAI-compatible LLM endpoint for Mnemopi remote mode
- `mnemopi.llmMode`: Use no LLM, the online tiny model (the TINY role from /models, else @smol), or a remote OpenAI-compatible endpoint
- `mnemopi.llmModel`: Optional LLM model name for Mnemopi remote mode
- `mnemopi.noEmbeddings`: Force deterministic FTS-only recall instead of vector embeddings
- `mnemopi.polyphonicRecall`: Enable 4-voice recall (vector, graph, fact, temporal) fused with reciprocal rank fusion
- `mnemopi.proactiveLinking`: Ingest new memories into the episodic graph as they are stored, linking them to related entities and memories
- `mnemopi.scoping`: global = one shared bank; per-project = isolated bank per cwd; per-project-tagged = project-local writes plus global recall visibility
- `model.loopGuard.checkAssistantContent`: Apply loop guard to assistant prose messages in addition to thinking logs
- `model.loopGuard.enabled`: Enable automatic stream loop detection for model reasoning and prose
- `model.loopGuard.toolCallReminder`: When a Gemini reasoning stream emits many consecutive planning headers without calling a tool, interrupt it and inject a reminder to issue a tool call (requires Loop Guard)
- `model.toolCallLoopGuard.enabled`: Detect consecutive identical tool calls across turns and inject a corrective steer
- `model.toolCallLoopGuard.exemptTools`: Tool names that may repeat consecutively without triggering the cross-turn loop guard
- `model.toolCallLoopGuard.threshold`: Consecutive identical tool calls required before the corrective steer is injected
- `modelRoleStorage`: Where model selector role assignments are saved
- `omitThinking`: Instruct upstream providers to completely omit thinking summaries from responses (where supported)
- `paste.largeMenuThreshold`: When a paste reaches this many lines, offer a menu to wrap it in a code block, wrap it in XML tags, or save it to a file. 0 disables the menu (large pastes still collapse to a [Paste] marker).
- `personality`: Communication style rendered into the system prompt's personality block
- `plan.autosave`: Automatically save approved plans to disk when plan mode completes
- `plan.autosaveDir`: Directory for autosaved plans. Supports ~, absolute, and cwd-relative paths. Empty uses <project>/.omp/plans/.
- `plan.defaultOnStartup`: Automatically enter plan mode at the start of every new session
- `plan.enabled`: Enable plan mode for read-only exploration and planning before execution
- `power.sleepPrevention`: Prevent the system sleeping during active sessions. Each level is cumulative — it adds the flags of all lower levels.
- `presencePenalty`: Penalty for introducing already-present tokens (-1 = provider default)
- `prewalk.enabled`: Start on the active model, then switch to a fast/cheap model (default the 'smol' role) at the first edit/write after the plan nudge's todo list exists — the strong model plans, commits the todos, and starts the implementation before handing off. Overridable per session with --prewalk / --no-prewalk.
- `proseOnlyThinking`: Omit code blocks from thinking summaries and replace them with an ellipsis
- `provider.appendOnlyContext`: Cache system prompt + tool specs and keep an append-only message log so provider prefix caches (DeepSeek, Xiaomi/SGLang, Anthropic) hit at maximum rate. Auto enables for known prefix-cache providers.
- `providers.anthropic.serverSideFallback`: When a Claude Fable 5 / Mythos 5 request is blocked by Anthropic's safety classifier, retry it on Claude Opus 5 server-side (Anthropic `server-side-fallback-2026-06-01` beta). Opt-in — leaving this off preserves the pre-fallback behavior for every request.
- `providers.antigravityEndpoint`: Endpoint routing strategy for google-antigravity providers (chat, search, image, discovery)
- `providers.autoThinkingMaxEffort`: Highest effort the `auto` classifier may resolve. `xhigh` keeps the classifier one tier below the top, so only an explicit `ultrathink` reaches `max`; `max` lets a turn the classifier judges exceptional bill the top tier on models that expose it.
- `providers.cacheRetention`: Prompt-cache retention forwarded to providers that support it (Anthropic, Bedrock, OpenRouter, OpenAI)
- `providers.fetch`: Reader backend priority for the fetch/read URL tool
- `providers.fireworksTier`: Default serving path (no service_tier)
- `providers.kimiApiFormat`: API format for Kimi Code provider (auto follows live model metadata)
- `providers.ollama-cloud.maxConcurrency`: Maximum concurrent Ollama Cloud subagent runs per process; 0 disables the provider-specific limit
- `providers.openai-codex.codeMode`: Route Codex code_mode_only models (GPT-5.6) through eval. The direct tools are eval, ask, todo, yield, think, checkpoint, and rewind. Use eval cells for other session tools. Mirrors codex-rs Code Mode. 'auto' follows the model catalog flag.
- `providers.openai-codex.codeModeDirectTools`: Extra direct tools for Codex Code Mode. The standard direct tools are eval, ask, todo, yield, think, checkpoint, and rewind.
- `providers.openaiLiveSteering`: Deliver messages typed while a GPT-6 response streams into that response over the Codex WebSocket, instead of waiting for the next tool boundary
- `providers.openaiWebsockets`: Websocket policy for OpenAI Codex models (auto uses model defaults, on forces, off disables)
- `providers.openrouterVariant`: Default routing-variant suffix appended to OpenRouter model IDs (overridden when the selector already names a variant)
- `providers.streamFirstEventTimeoutSeconds`: Seconds to wait for the first model stream event; -1 uses provider/env defaults, 0 disables the watchdog
- `providers.streamIdleTimeoutSeconds`: Seconds a model stream may stay silent between events; -1 uses provider/env defaults, 0 disables the watchdog
- `providers.tinyModelDevice`: Inference backend for local tiny models (titles + memory): an ONNX execution provider, or `mlx` to download MLX weights and run them through mlx-lm on Apple silicon. Default uses CPU-only ONNX. The PI_TINY_DEVICE env var overrides this.
- `providers.tinyModelDtype`: ONNX quantization/precision for local tiny models. Default uses each model's shipped dtype (q4); lower precision is faster, higher is more faithful. Ignored by the MLX backend (its repos are pre-quantized 4-bit). The PI_TINY_DTYPE env var overrides this.
- `python.interpreter`: Optional path to an exact Python executable. When set, automatic Python runtime discovery is skipped.
- `python.kernelMode`: Keep the IPython kernel alive across eval calls or start fresh each time
- `read.defaultLimit`: Default number of lines returned when agent calls read without a limit
- `read.renderMarkdown`: Render Markdown read results as formatted terminal Markdown previews instead of raw source
- `read.summarize.enabled`: Return structural code summaries when read is called without an explicit selector
- `read.summarize.minBodyLines`: Minimum multiline body or literal length before read summaries collapse it
- `read.summarize.minCommentLines`: Minimum multiline block comment length before read summaries collapse it
- `read.summarize.minTotalLines`: Files with fewer total lines are read verbatim instead of structurally summarized
- `read.summarize.prose`: Return structural summaries for Markdown and plain text reads
- `read.summarize.unfoldLimit`: Hard ceiling on summary size while BFS-unfolding. An unfold whose revealed lines would exceed this is skipped (that span stays folded) and unfolding continues with the remaining spans.
- `read.summarize.unfoldUntil`: BFS-unfold elidable spans until the summary is at least this many visible lines. 0 keeps only the outermost elisions.
- `read.toolResultPreview`: Render read tool results inline in the transcript instead of summary rows
- `readLineNumbers`: Prepend line numbers to read tool output by default
- `recap.enabled`: Generate a brief LLM recap of where things stand after the terminal has been idle
- `recap.idleSeconds`: Seconds to wait while idle before showing the recap
- `repetitionPenalty`: Penalty for repeated tokens (-1 = provider default)
- `retry.fallbackRevertPolicy`: When to return to the primary model after a fallback
- `retry.maxDelayMs`: Maximum wait between retries, in ms. When the provider asks us to wait longer than this and no credential or model fallback succeeds, the request fails fast instead of sleeping (e.g. 3-hour Anthropic rate-limit windows). 0 disables the ceiling — to let the session auto-resume through provider-stated quota resets.
- `retry.maxRetries`: Maximum retry attempts on API errors
- `retry.modelFallback`: Allow retry recovery to switch to configured fallback models
- `retry.usageAwareFallback`: Use reliable coding-plan quota reports to prefer same-provider accounts, then configured fallback models, before a hard usage limit. Ordinary configured API keys are excluded.
- `retry.usageReservePct`: Treat a coding-plan model as near its limit below this remaining percentage. Unknown or unmapped usage keeps the primary model.
- `retry.usageReservePolicy`: What to do when every same-provider coding-plan account is inside the reserve margin.
- `retry.waitForUsageReset`: When a provider reports usage-limit exhaustion with a reset time (5-hour or weekly quota windows on any provider), sleep until the reset instead of failing fast past retry.maxDelayMs. Waits are abortable (Esc) but also hold subagents, so leave off for unattended runs.
- `searxng.endpoint`: Base URL of a self-hosted SearXNG instance used for web search
- `secrets.enabled`: Obfuscate configured secrets and redact credential-shaped tokens before sending to AI providers
- `security.enabled`: Enable OMP-native security scan planning, execution, and the read-only security:// resource namespace
- `share.redactSecrets`: Run the secret obfuscator over /share snapshots before upload (uses the secrets.* config)
- `share.serverUrl`: Share viewer/upload base used by /share (encrypted blob upload + viewer; links are <base>/<id>#<key>)
- `share.store`: Where /share uploads the encrypted session blob
- `sharpshooter.model`: Model selector for extraction/consolidation, empty = smol role
- `shellMinimizer.enabled`: Compress verbose shell output (git, npm, cargo, etc.) before returning it to the agent
- `shellMinimizer.sourceOutlineLevel`: Source outline mode for cat/read of source files: default or aggressive
- `showHardwareCursor`: Show terminal cursor for IME support
- `skillful`: List available skills in the system prompt; disable to save context and toggle per-session with /skillful
- `skills.enableSkillCommands`: Register skills as /skill:name commands
- `skills.registryUrl`: Skillshare registry used by `omp skill` to install, search, and publish skills (https://host[:port])
- `snapcompact.shape`: Frame shape snapcompact prints text with (compaction archive and inline imaging). Auto picks a shape tuned for the current model.
- `snapcompact.systemPrompt`: Experimental: render selected system prompt text as dense PNG image(s) and attach to the first user message (vision models only). Saves tokens; loses prompt caching for imaged text.
- `snapcompact.toolResults`: Experimental: render large historical tool results as dense PNG image(s) instead of text (vision models only). Saves tokens on accumulated read/search output.
- `speech.enabled`: Speak the assistant's output aloud through the speakers as it streams
- `speech.enhanced`: Rewrite assistant output into natural spoken prose with the tiny/smol model before synthesis (describes code, drops links and markdown). Falls back to mechanical cleanup on failure
- `speech.mode`: What to speak: all = assistant messages + thinking; assistant = messages only; yield = only the final message at turn end
- `speech.voice`: Kokoro voice used when speaking the assistant's output aloud
- `speechgen.enabled`: Enable the tts tool for on-device (Kokoro) or xAI Grok Voice speech-file synthesis
- `spelling.autocomplete`: Show macOS dictionary word completions as inline hints accepted with Tab
- `spelling.autocorrect`: Apply confident macOS spelling corrections after completed words
- `spelling.typoDetection`: Mark misspelled prompt words with the active macOS dictionaries
- `startup.changelogMode`: Choose whether update notes start as a summary, full details, or stay hidden
- `startup.checkUpdate`: Check for omp updates on startup
- `startup.quiet`: Skip welcome screen and startup status messages
- `startup.setupWizard`: Show newly added onboarding steps once per setup version
- `startup.showSplash`: Show the full animated setup splash on normal interactive startup without rerunning setup. Quiet Startup still suppresses it.
- `statusLine.compactThinkingLevel`: Show the thinking level as a single icon on the model name instead of a separate ` · <level>` suffix.
- `statusLine.contextLine`: How the line between the left and right segments reflects context usage (box composer only)
- `statusLine.preset`: Pre-built status line configurations
- `statusLine.separator`: Style of separators between segments
- `statusLine.sessionAccent`: Use the session name color for the editor border and status line gap
- `statusLine.showHookStatus`: Display hook status messages below the status line
- `statusLine.transparent`: Use the terminal's default background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped because they need a contrasting fill to bridge into the surrounding terminal.
- `steeringMode`: How to process queued messages while agent is working
- `stream.redactPatterns`: Additional regular expressions redacted from every streamed row, on top of env/secrets.yml values and built-in credential shapes
- `stream.serverUrl`: Live stream server used by `omp stream` (https://host[:port]); viewers watch at <base>/<your Stencil username>
- `stt.enabled`: Enable speech-to-text input via microphone
- `stt.submitTrigger`: Choose when speech dictation automatically submits: Never, Release (2+ words), Release with complete sentence, or When I Say Submit.
- `symbolPreset`: Glyph set for icons and symbols (Unicode, Nerd Font, or ASCII)
- `task.agentIdleTtlMs`: How long an idle subagent stays live in memory before being parked to disk (ms). Parked agents are revived automatically when messaged or resumed. 0 keeps idle agents live until exit.
- `task.batch`: Switch the task tool to its batch shape: one call carries { context, tasks[] } — one subagent per item, with an optional per-item agent (defaulting to the session spawn-policy agent), per-item isolation, and a required shared context prepended to every assignment. With async.enabled=true, each spawn runs as an independent background agent with the normal idle/parked lifecycle; otherwise the call blocks for merged results. Disable to restore the flat single-spawn schema.
- `task.eager`: How strongly to push delegating work to subagents
- `task.enableEffort`: Expose the optional effort parameter on task spawns, allowing callers to override each subagent's thinking level
- `task.enableLsp`: Allow subagents spawned via the task tool to use the lsp tool. Off by default to keep subagents cheap; enable when LSP-aware delegation is worth the extra tokens.
- `task.isolation.apply`: Automatically apply successful isolated task changes to the parent checkout; disable to retain patch or branch artifacts
- `task.isolation.commits`: Commit message style for nested repo changes (generic or AI-generated)
- `task.isolation.enabled`: Run subagents in an isolated copy of the checkout and integrate their changes afterwards
- `task.isolation.merge`: How isolated task changes are integrated (patch apply or branch merge)
- `task.maxConcurrency`: Maximum number of subagents running concurrently
- `task.maxEffort`: Maximum reasoning effort allowed for the task tool's per-spawn effort hint. Lower values prevent callers from escalating subagents above this ceiling; the default preserves the model's full range.
- `task.maxRecursionDepth`: How many levels deep subagents can spawn their own subagents
- `task.maxRuntimeMs`: Hard wall-clock limit per subagent (ms). 0 disables it. Defense-in-depth against provider-side stream hangs that escape the inference-layer watchdog; triggers a normal subagent abort with a 'timed out' reason.
- `task.prewalk`: Arm prewalk for the bundled generic `task` subagent: it starts on its resolved model, plans and begins the implementation, then hands off to the 'smol' role at its first edit/write. Per-agent overrides (task.agentPrewalk, configured from the /agents hub) and user agent `prewalk` frontmatter apply regardless of this toggle.
- `task.showResolvedModelBadge`: Display the actual model ID used by each subagent in the task widget status line
- `task.softRequestBudget`: Soft per-subagent request budget (assistant requests per run). Crossing it injects a wrap-up steering notice (see task.softRequestBudgetNotice); at 1.5x the budget the run is force-stopped and the agent must yield its partial findings. 0 disables the guard. Bundled scout/sonic agents cap out at a lower built-in budget, so a value below that cap still applies to them.
- `task.softRequestBudgetNotice`: Inject one steering notice when a subagent crosses its soft request budget, asking it to wrap up before the 1.5x forced-yield stop.
- `tasks.todoClearDelay`: Delay before completed or abandoned todos are removed from the todo widget
- `temperature`: Sampling temperature (0 = deterministic, 1 = creative, -1 = provider default)
- `terminal.showImages`: Render images inline in the terminal
- `terminal.showProgress`: Emit OSC 9;4 indeterminate progress while the agent or context maintenance is running
- `textVerbosity`: OpenAI Responses and Codex response verbosity (low, medium, or high)
- `theme.dark`: Theme used when the terminal has a dark background
- `theme.light`: Theme used when the terminal has a light background
- `tier.advisor`: Service Tier for the advisor model. None = standard processing; Inherit = match the main agent's live per-family tiers; pick a value to apply it to the advisor model's family.
- `tier.google`: Processing tier for Gemini (Google AI Studio + Vertex) requests, and Google-family models routed via OpenRouter (none = omit). Sent as the top-level `serviceTier` field.
- `tier.openai`: Processing tier for OpenAI / OpenAI-Codex requests, and OpenAI-family models routed via OpenRouter (none = omit). Sent as `service_tier`.
- `tier.subagent`: Service Tier for spawned task/eval subagents. Inherit = match the main agent's live per-family tiers (tracks /fast); pick a value to apply it to whichever family the subagent's model belongs to.
- `title.refreshOnReplan`: Refresh generated session titles after todo init replans unless the title was set by the user
- `todo.eager`: How strongly to push automatic todo-list creation after the first message
- `todo.enabled`: Enable the todo tool for task tracking
- `todo.reminders`: Remind the agent to complete todos before stopping
- `todo.remindersMax`: Maximum number of todo reminders before giving up
- `tools.abortOnFabricatedResult`: With in-band tool calls, stop the model immediately when it starts hallucinating a tool result mid-turn. Disable to let the model finish generating and discard the fabricated continuation instead.
- `tools.approval`: Per-tool approval policies. Set to 'allow' to auto-approve, 'prompt' to require confirmation, or 'deny' to block. Overrides are honored in every approval mode.
- `tools.approvalMode`: Default approval behavior for tool calls. 'Always ask' auto-approves read-only tools only. 'Write' auto-approves read and workspace-write tools. 'Yolo' auto-approves all tiers; user policy may still prompt or block.
- `tools.artifactHeadBytes`: Amount of head content kept inline alongside the tail when output spills to artifact (middle elision). 0 disables — keep tail only.
- `tools.artifactSpillThreshold`: Tool output above this size is saved as an artifact; tail is kept inline
- `tools.artifactTailBytes`: Amount of tail content kept inline when output spills to artifact
- `tools.artifactTailLines`: Maximum lines of tail content kept inline when output spills to artifact
- `tools.format`: Controls how tools are exposed to the model. Auto uses provider-native tool calls unless the selected model is marked as not supporting them, then falls back to the GLM owned dialect. Native forces provider-native tools; the other values force the named owned dialect.
- `tools.intentTracing`: Ask the agent to describe the intent of each tool call before executing it
- `tools.maxTimeout`: Maximum timeout in seconds the agent can set for any tool (0 = no limit)
- `tools.outputMaxColumns`: Per-line byte cap for streaming tool outputs (bash, python, js eval) and `read`. Lines wider than this are ellipsis-truncated; remaining bytes up to the next newline are dropped. 0 disables.
- `tools.speculativeExecution.enabled`: Enable the discard-safe first slice: validated local reads through direct read calls and nested eval. Network requests, provider completions, and live filesystem writes are not part of this baseline.
- `tools.speculativeExecution.maxInFlight`: Maximum number of validated local reads allowed to run before normal dispatch.
- `tools.xdev`: Mount rarely-used (discoverable) tools under xd:// device URLs driven via read/write instead of shipping their schemas on every request. Sessions whose explicit tool list grants read but omits write mount devices through a device-only write transport (filesystem writes stay rejected). Disable to expose every enabled tool top-level.
- `tools.xdevDocs`: Choose which mounted-device docs and schemas are inlined in the system prompt. Built-ins keeps core tools inline while MCP and extension tools stay on-demand.
- `tools.xdevInlineDevices`: When xd:// Prompt Docs is Built-ins Only, inline dynamic devices whose names match these glob patterns (for example mcp__context_mode_*). Catalog Only ignores this setting.
- `topK`: Sample from top-K tokens (-1 = provider default)
- `topP`: Nucleus sampling cutoff (0-1, -1 = provider default)
- `treeFilterMode`: Default filter mode when opening the session tree
- `tts.localVoice`: Kokoro voice used by the local TTS backend (American/British, female/male)
- `ttsr.builtinRules`: Load the default rules shipped with the agent (override individually with ttsr.disabledRules)
- `ttsr.contextMode`: What to do with partial output when TTSR triggers
- `ttsr.disabledRules`: Rule names to ignore entirely (applies to bundled defaults and your own rules)
- `ttsr.enabled`: Interrupt the agent mid-stream when output matches rule patterns (Time-Traveling Stream Rules)
- `ttsr.interruptMode`: When to interrupt mid-stream vs inject warning after completion
- `ttsr.judge`: Ask the judge model role each `question` rule about completed replies, reasoning, and tool calls; a yes injects the rule as a warning
- `ttsr.repeatGap`: Messages before a rule can trigger again
- `ttsr.repeatMode`: How rules can repeat: once per session or after a message gap
- `tui.codexResetFireworks`: Celebrate unscheduled Codex weekly usage resets and newly banked saved resets with a top-third fireworks overlay that remains until Escape
- `tui.hyperlinks`: Wrap paths and URLs in OSC 8 hyperlinks for terminal-native click-to-open (auto: detect support; off: never; always: unconditional)
- `tui.imeSafeCursor`: Move the prompt's bottom border to a separate row so macOS IME preedit cannot displace it
- `tui.maxInlineImageColumns`: Maximum width in terminal columns for inline images (default 100). Set to 0 for unlimited (bounded only by terminal width).
- `tui.maxInlineImageRows`: Maximum height in terminal rows for inline images (default 20). Set to 0 to use only the viewport-based limit (60% of terminal height).
- `tui.maxInlineImages`: Maximum number of inline images kept as live terminal graphics (default 8). Older images fall back to a text placeholder via a full redraw once the limit is exceeded. Set to 0 to keep every image (no limit).
- `tui.mouse`: Capture mouse clicks in the main session so live subagent cards and HUD rows focus on click, with a hover highlight on the target. Native text selection becomes Shift+drag and wheel scroll becomes Shift+wheel while on
- `tui.reactions`: Invite the agent to react to your message with an emoji badge on its bubble
- `tui.renderMermaid`: Render Mermaid fenced code blocks as ASCII diagrams
- `tui.resizeScrollback`: How a settled terminal resize refreshes transcript rows retained in terminal scrollback
- `tui.textSizing`: Render Markdown H1 headings at 2x scale using Kitty's OSC 66 text-sizing protocol. Only takes effect on Kitty terminals; ignored everywhere else. Off by default.
- `tui.tight`: Remove the 1-character horizontal padding from the left and right of the terminal output
- `tui.titleSpinner`: Glyph set for the working-state spinner in the terminal title — braille sweep, filling moon, single-dot cycle, or ASCII-safe line
- `tui.titleState`: Show the agent run state in the terminal title's separator — an animated spinner while working (a static ':' under WSL), '>' when it's your turn, '!' when the agent is waiting on you
- `tui.vimMode`: Modal prompt editing. Escape leaves Insert mode; Normal mode has hjkl, 0, $, ^, w, b, e, gg, G, counts, x/D/C, dd/yy, p and u; operators take motions or text objects (diw, ca(, dap); v/V start a Visual selection that y copies and d deletes
- `tui.vimModeDisplay`: How the current Vim mode appears in the status line
- `update.channel`: Update channel used by omp update and the startup update check
- `vault.enabled`: Enable the vault:// internal URL for reading and editing Obsidian vault content via the Obsidian CLI. When disabled, vault:// resolution is refused and the vault:// entry is omitted from the system prompt.
- `web_search.enabled`: Enable the web_search tool for live web results
- `workspace.additionalDirectories`: Extra workspace directories added to every session as additional roots (multi-root workspace). Managed live via /add-dir and /remove-dir. Paths resolve relative to cwd; absolute paths recommended. The agent is told these roots exist and can read/grep/glob them.
- `worktree.base`: Base directory for agent-managed worktrees — task-isolation copies, `github` PR checkouts, and `omp worktree` cleanup all live here. Unset uses ~/.omp/wt. Must be an absolute or ~-relative path; relative paths are ignored. The OMP_WORKTREE_DIR env var overrides this.
- `worktree.cleanSource`: When creating a worktree with `/wt`, reset tracked changes and remove untracked files from the original checkout after carrying them over
- `worktree.clone`: New worktrees from `github pr_checkout` and `git worktree add` in bash start as a copy-on-write clone of the current checkout so ignored build artifacts (node_modules, target) carry over; falls back to a plain checkout when the filesystem cannot clone
