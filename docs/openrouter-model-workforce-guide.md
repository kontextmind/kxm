# OpenRouter Model Workforce and Workflow Architecture Guide

## Table of Contents

1. [Video Creation and Editing](#video-creation-and-editing)
2. [New Development](#new-development)
3. [Debugging, Code Fixes and Improvements](#debugging-code-fixes-and-improvements)
4. [Business and Personal](#business-and-personal)
5. [Architecture](#architecture)
6. [Analytics](#analytics)
7. [UI/UX Design for Web, Mobile and TUI Interfaces](#uiux-design-for-web-mobile-and-tui-interfaces)

---

## Research and Dual-Critic Multi-Agent Consensus

- **3 Specialized Research Subagents** formulated the baseline workflows and role mappings across multi-modal video/analytics, engineering/architecture, and debugging/business.
- **Critic 1 (Lead Technical Architect & Modality Evaluator)** audited input/output modalities, AST/grammar verification, terminal emulator protocols, and empirical benchmarks (such as Terminal-Bench 2.1).
- **Critic 2 (Systems Economist & Operational Reliability Engineer)** audited unit economics, 1M+ context window scaling, multi-stage ingestion filter gates, and resilience against context truncation cliffs.

---

## Master 4-Tier Operational Routing Architecture

To eliminate cost waste and prevent context overflow, all agentic pipelines operate on a standardized 4-tier model hierarchy:

| Tier | Economic Band | Context Window | Primary Models | Core Workload Profile |
|---|---|---|---|---|
| **Tier 0: Filter & Ingestion** | $0.03 - $0.20 / M | 1.0M - 1.31M | DeepSeek-V4-Flash, Qwen-3.7-Flash, GLM-5.3-Flash, GPT-5.6-Luna | High-throughput telemetry, raw log ingestion, triage, video pre-filtering, and initial inbox classification. |
| **Tier 1: Workhorse & Engine** | $0.30 - $1.00 / M | 262k - 1.05M | Gemini-3.8-Flash, Qwen-3-Coder-Plus, DeepSeek-V4-Pro, Devstral-2512 | Routine code generation, multimodal visual QA, Text-to-SQL, AST diff patching, and fast tool dispatching. |
| **Tier 2: Precision & Critic** | $1.25 - $4.00 / M | 200k - 1.05M | GPT-5.6-Sol, Grok-4.6, Claude Sonnet 5, OpenAI o3, DeepSeek-R1, Codex 5.3 | Primary code writing, formal contract generation, concurrency race diagnosis, and causal inference. |
| **Tier 3: Sovereign Architecture** | $5.00 - $15.00 / M | 1.0M - 1.05M | Claude Fable 5.1, Claude Opus 5, GPT-6-Astra-Pro (Escalation only) | Designated architecture critic, executive brief, high-stakes legal redlining, and sovereign RFC review. |

---

## Video Creation and Editing

### Category 1 Workflows Overview

1. **Generative AI Video Production Pipeline:** Ideation $\to$ Scriptwriting $\to$ Shot Storyboarding $\to$ Prompt Synthesis $\to$ Video Generation $\to$ Visual Continuity QA $\to$ Audio/Foley Scoring $\to$ Final Render.
2. **Automated Long-to-Shorts Content Repurposing:** Raw Media Ingestion (1–4h) $\to$ Semantic Hook Extraction $\to$ Active Speaker Tracking & Dynamic 9:16 Reframing $\to$ B-Roll Matching $\to$ Kinetic Typography & Packaging.
3. **Programmatic Post-Production & Tool-Calling Assembly:** Codec/Asset Ingestion $\to$ Rough-Cut Compilation $\to$ Deterministic NLE/FFmpeg Filtergraph Assembly $\to$ Color LUT/Loudness Normalization $\to$ Broadcast Compliance Gate.

---

### Workflow 1.1: Generative AI Video Production Pipeline

#### Role 1.1.1: Scriptwriter & Storyboard Director

*Domain:* Cinematic screenplays, narrative arcs, shot descriptions, scene tempos, and blocking instructions.

1. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Frontier narrative depth, emotional nuance, and long-horizon multi-act pacing across 1M context.
2. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Highly responsive, steerable screenplay formatting (Fountain/Final Draft XML) at 1/3rd the operating cost.
3. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Punchy dialogue cadence, contemporary cultural fluency, and unconventional creative treatments.
4. **`mistralai/mistral-large-2512`** (262k ctx | $0.50 / $1.50) — Multilingual narrative drafting and shot list breakdown at exceptional unit economics.
5. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Complex multi-character worldbuilding and director-ready blocking notes.

#### Role 1.1.2: Prompt Synthesizer & Video Diffusion Prompt Engineer

*Domain:* Deconstructing storyboards into diffusion/autoregressive prompts (framing, camera vectors, lighting, negative constraints).

1. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Fast spatial-visual comprehension; converts visual concepts into diffusion parameters at high throughput.
2. **`bytedance-seed/seed-2-1-turbo`** (262k ctx | $0.50 / $2.50) — Native diffusion tuning; outputs compact, weighted prompts with motion velocity vectors.
3. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Complex camera motion prompting (e.g., *dolly zoom with 45° pan*) without semantic drift.
4. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — 2.4T multimodal MoE tuned across global generative video backends (Wan, Kling, Sora, Runway).
5. **`openai/gpt-5.6-sol-pro`** (1.05M ctx | $2.00 / $10.00) — Strict schema compliance for programmatic video generation APIs.

#### Role 1.1.3: Multimodal Visual Continuity & Character Consistency Engine

*Domain:* Compares generated frames against reference sheets to prevent facial, wardrobe, lighting, and environmental drift.

1. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — Native multi-image/video reasoning; cross-references character turnarounds across a 1M token context.
2. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Real-time frame-by-frame similarity scoring and spatial discrepancy detection.
3. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — Fine-grained texture, logo, and wardrobe consistency tracking.
4. **`z-ai/glm-5.3-flash`** (1.31M ctx | $0.075 / $0.25) — Ultra-low-cost screening gate across high-volume rendering batches.
5. **`openai/gpt-5.4-image-2`** (272k ctx | $8.00 / $15.00) — *Image Output Engine*; generates in-painted corrective reference keyframes.

#### Role 1.1.4: Multimodal Video QA & Defect Inspection Engine

*Domain:* Scans raw video renders for frame flicker, non-physical deformations, temporal morphing, and anatomical glitches.

1. **`z-ai/glm-5.3-flash`** (1.31M ctx | $0.075 / $0.25) — **Tier-0 Primary Ingestion Gate**; 1.31M native video context at $0.075/M prompt.
2. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Fast, reliable defect classification and timestamp annotation.
3. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — Escalation arbiter for subtle temporal and physical artifact validation.
4. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — Evaluates physics continuity (fluid dynamics, shadows, reflections).
5. **`bytedance-seed/seed-2-1-turbo`** (262k ctx | $0.50 / $2.50) — Emits structured defect reports categorized by error severity.

#### Role 1.1.5: Audio-Visual Compositor & Sound Design Orchestrator

*Domain:* Analyzes video hit points, generates music briefs, places Foley effects, and aligns audio with visual cues.

1. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Native multimodal engine (video + audio + text); detects hit points and sync offsets.
2. **`google/lyria-3-pro-preview`** (1.05M ctx | $0.08 / song) — Generates high-fidelity 48kHz audio and scoring directly from visual prompts.
3. **`openai/gpt-audio`** (128k ctx | $2.50 / $10.00) — Native speech and audio synthesis; cadence and vocal inflection alignment.
4. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Authors time-indexed EDL/FCPXML sound design cue sheets.
5. **`openai/gpt-5.6-sol-pro`** (1.05M ctx | $2.00 / $10.00) — Orchestrates multi-channel frequency and ducking parameter hierarchies.

---

### Workflow 1.2: Automated Long-to-Shorts Content Repurposing Pipeline

#### Role 1.2.1: Long-Context Multimodal Highlight & Hook Extractor

*Domain:* Ingests 1–4 hour recordings, identifying viral hooks, high-retention segments, and standalone topics.

1. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Scans multi-hour video/audio streams; extracts timestamped clips at sub-$0.50 cost per hour.
2. **`z-ai/glm-5.3-flash`** (1.31M ctx | $0.075 / $0.25) — Massive 1.31M context for bulk background indexing of livestreams.
3. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — Deep semantic extraction for complex lectures and technical panels.
4. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — Correlates audience physical cues (laughter, applause) with audio punchlines.
5. **`moonshotai/kimi-k3`** (1.05M ctx | $3.00 / $15.00) — Long-horizon needle-in-a-haystack topic retrieval across long discussions.

#### Role 1.2.2: Spatial Reframing & Visual B-Roll Matching Agent

*Domain:* Tracks active speakers for 16:9 to 9:16 dynamic cropping and generates semantic B-roll search queries.

1. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Computes normalized bounding-box coordinates for smooth virtual camera pans.
2. **`qwen/qwen3.8-flash`** (1M ctx | $0.15 / $0.47) — Real-time contextual B-roll keyword and stock asset search query generation.
3. **`xiaomi/mimo-v2.5`** (1.05M ctx | $0.14 / $0.28) — Native omnimodal video model with spatial frame perception.
4. **`bytedance-seed/seed-2-1-turbo`** (262k ctx | $0.50 / $2.50) — Visual tracking and keyframe coordinate mapping.
5. **`amazon/nova-2-lite-v1`** (1M ctx | $0.30 / $2.50) — Low-cost video indexing and visual scene classification.

#### Role 1.2.3: Kinetic Typographer & Viral Packaging Agent

*Domain:* Formats word-level subtitle timings, selects kinetic text styling/colors, and drafts click-through titles.

1. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — High cultural fluency; generates punchy titles, descriptions, and hashtags matching platform trends.
2. **`mistralai/mistral-large-2512`** (262k ctx | $0.50 / $1.50) — Cost-effective structured JSON/ASS subtitle styling and localization.
3. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Polished typography formatting, emphasis palettes, and social pacing.
4. **`qwen/qwen3.8-flash`** (1M ctx | $0.15 / $0.47) — Real-time formatting of raw Whisper transcripts into styled subtitle chunks.
5. **`openai/gpt-5.6-sol-pro`** (1.05M ctx | $2.00 / $10.00) — Precise timing verification and deterministic subtitle schema alignment.

---

### Workflow 1.3: Programmatic Post-Production & Tool-Calling Assembly Pipeline

#### Role 1.3.1: Tool-Calling Timeline Assembly & NLE Code Engineer

*Domain:* Emits executable FFmpeg filtergraphs, OpenTimelineIO (OTIO) JSON, and Remotion/DaVinci Resolve Python scripts.

1. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Frontier code generation for complex multi-input FFmpeg filtergraphs and OTIO structures.
2. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — 1M-context Remotion/React-video and Python automation specialist at low cost.
3. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Multi-track timecode arithmetic, drop-frame calculations, and nested timeline logic.
4. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Inspects raw asset metadata directly and constructs execution CLI commands.
5. **`mistralai/devstral-2512`** (262k ctx | $0.40 / $2.00) — Lightweight Bash and Python timeline glue scripts.

#### Role 1.3.2: Multimodal Broadcast Compliance & Quality Gatekeeper

*Domain:* Verifies broadcast safe zones, subtitle synchronization, audio loudness (EBU R128), and photosensitive epilepsy (PSE) safety.

1. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — Multi-modal audit across 1M tokens; validates title safety, strobe risks, and branding.
2. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Fast automated gatekeeper in rendering CI/CD; catches black frames and desync.
3. **`meta/muse-spark-1.3`** (1.05M ctx | $1.25 / $4.25) — Native audio/video inspection of loudness dynamics and visual pacing.
4. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — High spatial resolution checks for color clipping and compression banding.
5. **`z-ai/glm-5.3-flash`** (1.31M ctx | $0.075 / $0.25) — High-throughput preliminary broadcast screening.

---

## New Development

### Category 2 Workflows Overview

1. **Greenfield Software Engineering & Monorepo Scaffolding:** PRD Ingestion $\to$ System Planning $\to$ API Spec/Contract Authoring $\to$ Workspace Scaffolding $\to$ Core Backend & Data Logic $\to$ Full-Stack UI Implementation $\to$ Tool/SDK Integrations $\to$ Automated Verification.

---

### Workflow 2.1: Greenfield Software Engineering & Monorepo Scaffolding

#### Role 2.1.1: Lead Systems Planner & Task Decomposer

*Domain:* Decomposes requirements into an executable, dependency-ordered DAG of modules, tasks, and verification gates.

1. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Sovereign systems planner; strict boundary isolation and non-overlapping DAG synthesis.
2. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Exceptional price-to-reasoning ratio; detects race conditions and circular dependencies.
3. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Enterprise task decomposition and critical-path scheduling across massive PRDs.
4. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Pragmatic engineering focus; rapid modular task decomposition.
5. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — Broad framework knowledge; maps migration orders and build prerequisites.

#### Role 2.1.2: Spec & Contract Generator (OpenAPI/Protobuf/Zod)

*Domain:* Authors zero-ambiguity API contracts, type definitions, and schema validation rules before implementation begins.

1. **`openai/gpt-5.6-sol`** (1.05M ctx | $2.00 / $10.00) — Premier schema contract generator; 100% compliant OpenAPI 3.1, Protobuf v3, and JSON schemas.
2. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — High-throughput Zod/Pydantic validation pipeline synthesis.
3. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Fast translation of data dictionaries into TypeScript interfaces.
4. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — 1M-context contract verification across monorepo boundaries.
5. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Reserved for mission-critical authentication and security contract definitions.

#### Role 2.1.3: Scaffold & Build Setup Specialist

*Domain:* Provisions monorepo workspace topologies (Turborepo, Cargo, pnpm), linters, Docker multi-stage builds, and CI pipelines.

1. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Designated native repo builder; resolves path aliases, linkings, and workspace configs cleanly.
2. **`mistralai/devstral-2512`** (262k ctx | $0.40 / $2.00) — Developer-focused open model; produces clean Makefiles, Taskfiles, and tool configs.
3. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — Coordinates cross-package build configs and dependency lockfiles in 1M context.
4. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Complex CI/CD workflows and multi-stage container build optimizations.
5. **`kwaipilot/kat-coder-pro-v2.5`** (262k ctx | $0.74 / $2.96) — Resilient project scaffolding and bundler configuration.

#### Role 2.1.4: Core Backend & Data Layer Implementer

*Domain:* Implements domain entities, SQL queries/migrations, ORM persistence, concurrency primitives, and transactional boundaries.

1. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Admitted native writer; passes deterministic verify gates (`npm run verify`) on the first pass with minimal rework.
2. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — 1M-context open-weight anchor; generates performant database layers and CRUD services.
3. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Exceptional database logic, indexing, and edge-case domain implementation.
4. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Algorithmic precision in Rust, Go, Python, and TypeScript concurrent systems.
5. **`kwaipilot/kat-coder-pro-v2.5`** (262k ctx | $0.74 / $2.96) — Multi-file backend logic implementation adhering to project coding patterns.

#### Role 2.1.5: Frontend & Full-Stack UI Implementer

*Domain:* Constructs stateful UI components, routing, client cache management, responsive Tailwind styles, and accessible interactions.

1. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Industry leader for UI engineering; elegant Tailwind/React component hierarchies and hooks.
2. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Fast streaming UI prototyping, token parsing, and JSX/TSX tree generation.
3. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Fast full-stack wiring, shadcn/ui integration, and client-server action implementations.
4. **`bytedance-seed/seed-2.0-code`** (262k ctx | $0.50 / $3.00) — Specialized web engineering model for interactive client components.
5. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Complex client cache mutations (TanStack Query) and optimistic UI state machines.

#### Role 2.1.6: Tool/SDK & 3rd-Party Integration Specialist

*Domain:* Wires external APIs, authentication flows (OAuth2/OIDC), webhook validation, cloud SDKs, and async worker queues.

1. **`openai/gpt-5.6-sol`** (1.05M ctx | $2.00 / $10.00) — Flawless SDK synthesis, webhook signature validation, and API adapter error handling.
2. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Robust glue code, rate-limiting backoff algorithms, and token refresh loops.
3. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — Ingests full third-party API documentation to emit typed wrapper clients.
4. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Low-cost mapping of disparate vendor payloads into internal domain models.
5. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — High-speed webhook listener and protocol transformation adapter.

---

## Debugging, Code Fixes and Improvements

### Category 3 Workflows Overview

1. **Production Incident RCA & Crash Diagnostics:** Telemetry/Dump Ingestion $\to$ Signal De-noising $\to$ Causal Graph Reconstruction $\to$ Minimal Repro PoC $\to$ Blameless Post-Mortem.
2. **Precision Code Refactoring & Regression Repair:** Codebase Smell Analysis $\to$ Modular Decomposition $\to$ Surgical Multi-File AST Transforms $\to$ Static Typing & Contract Verification.
3. **Flaky Test Remediation & Vulnerability Patching:** Flakiness Root-Cause Extraction $\to$ Deterministic Mock/Async Hardening $\to$ Taint Flow Analysis $\to$ Defensive Patching $\to$ Adversarial Mutation Verification.

---

### Workflow 3.1: Production Incident RCA & Crash Diagnostics

#### Role 3.1.1: Incident Triage & Telemetry Investigator

*Domain:* Consumes raw multi-gigabyte log dumps, APM spans, and core dumps; filters noise and isolates fault boundaries.

1. **`deepseek/deepseek-v4-flash-0731`** (1.31M ctx | $0.05 / $0.10) — **Tier-0 Primary Ingestion Gate**; 1.31M context at $0.05/M prompt.
2. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Multimodal crash analysis (logs + APM graphs + error screenshots).
3. **`openai/gpt-5.6-luna`** (1.05M ctx | $0.20 / $1.20) — Fast structured JSON classification of stack traces across 1M tokens.
4. **`x-ai/grok-4.20`** (2M ctx | $1.25 / $2.50) — 2M context window for cross-service distributed tracing scans.
5. **`qwen/qwen3.8-flash`** (1M ctx | $0.15 / $0.47) — High-throughput multilingual log scanner for multi-cluster events.

#### Role 3.1.2: Deep Forensic & Causal Graph Analyst

*Domain:* Analyzes concurrent thread traces, memory corruptions, and race conditions to isolate line-level defects.

1. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Frontier test-time reasoning on distilled call graphs; uncovers edge-case race conditions.
2. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Deep forensic reasoning across complex asynchronous lifecycles in 1M context.
3. **`deepseek/deepseek-r1-0528`** (164k ctx | $0.50 / $2.15) — Open chain-of-thought mathematical and logical bug deduction.
4. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Multi-repository diagnostic investigations for systemic architectural failures.
5. **`openai/gpt-6-astra`** (1.05M ctx | $10.00 / $50.00) — Long-context multi-system causal graph reconstruction.

#### Role 3.1.3: Repro Test & PoC Synthesizer

*Domain:* Translates trace observations into isolated, runnable reproduction unit/integration tests and scripts.

1. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Fast, repo-accurate test writer; minimal boilerplate without hallucinating dependencies.
2. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — Ingests full test frameworks; generates parameterized reproduction suites.
3. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Specialized mocking of network calls, clocks, and internal database states.
4. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Parameterized property-based regression test harnesses (Hypothesis/QuickCheck).
5. **`mistralai/devstral-2512`** (262k ctx | $0.40 / $2.00) — Concise, executable unit-test reproductions.

---

### Workflow 3.2: Precision Code Refactoring & Regression Repair

#### Role 3.2.1: Refactoring Architect & Dependency Strategist

*Domain:* Analyzes code coupling, designs clean modular boundaries, and authors step-by-step non-breaking migration plans.

1. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Strict boundary isolation and dependency inversion planning across large codebases.
2. **`z-ai/glm-5.3`** (1.31M ctx | $1.40 / $4.40) — 1.31M context full-repo symbol dependency analysis.
3. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Deep architectural judgment; anticipates runtime blast radius during refactors.
4. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Cost-efficient full-codebase impact analysis.
5. **`moonshotai/kimi-k3`** (1.05M ctx | $3.00 / $15.00) — Multi-package refactoring plan generation.

#### Role 3.2.2: Precision Code Transform Implementer

*Domain:* Executes surgical multi-file edits, applying design patterns while preserving comments and formatting.

1. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Designated native writer; fast execution of multi-file semantic code changes.
2. **`relace/relace-apply-3`** (256k ctx | $0.85 / $1.25) — Specialized model for deterministic AST code patch merging without syntax corruption.
3. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — High-precision refactoring of complex pointer/generic logic.
4. **`morph/morph-v3-large`** (262k ctx | $0.90 / $1.90) — 4,500 tok/sec high-accuracy mechanical patch application.
5. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Broad contextual refactoring across multi-file boundaries.

#### Role 3.2.3: Semantic Equivalence & Interface Verifier

*Domain:* Verifies public contract compliance, runs compiler diagnostics (`tsc --noEmit`), and ensures zero regressions.

1. **`openai/gpt-5.6-sol`** (1.05M ctx | $2.00 / $10.00) — Designated CLI/spec critic; resolves compiler and type-checker cascades.
2. **`openai/o3-mini-high`** (200k ctx | $1.10 / $4.40) — Deep symbolic verification that AST refactors maintain behavioral equivalence.
3. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Full-repo type-check and semantic regression verification.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Verifies backwards compatibility and deprecation notices across public APIs.
5. **`mistralai/devstral-2512`** (262k ctx | $0.40 / $2.00) — Fast lint and compiler-error verification.

---

### Workflow 3.3: Flaky Test Remediation & Vulnerability Patching

#### Role 3.3.1: Concurrency & Flakiness Detective

*Domain:* Untangles timing hazards, async wait conditions, shared state pollution, and unhandled promise rejections.

1. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Unrivaled reasoning on async timing races, microtask queues, and thread contention.
2. **`deepseek/deepseek-r1-0528`** (164k ctx | $0.50 / $2.15) — Exposes hidden execution dependencies and global singleton leaks between tests.
3. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Ingests hundreds of CI failure logs to map statistical failure distributions.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Identifies test runner interactions with underlying event loops.
5. **`openai/gpt-6-astra`** (1.05M ctx | $10.00 / $50.00) — Complex distributed deadlocks and environmental flakiness.

#### Role 3.3.2: Defensive Patch & Hardening Engineer

*Domain:* Synthesizes fail-closed security fixes (parameterized queries, sanitization, constant-time comparisons).

1. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Surgical security patch generator using secure coding primitives.
2. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Rapid patch application that passes `npm run verify` cleanly.
3. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — High-throughput defensive refactoring across large repos.
4. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Applies defensive validation without breaking valid user flows.
5. **`bytedance-seed/seed-2.0-code`** (262k ctx | $0.50 / $3.00) — Web and client-side sanitization hardening.

#### Role 3.3.3: Adversarial Security & Mutation Auditor

*Domain:* Authors exploit PoCs, executes mutation testing, and ensures patches introduce zero bypass vectors.

1. **`openai/gpt-5.6-sol-pro`** (1.05M ctx | $2.00 / $10.00) — Pro reasoning mode; probes candidate fixes with adversarial bypass payloads.
2. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Fuzzing parameter generation and mathematical boundary mutation testing.
3. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Unforgiving security critic; catches incomplete sanitization and secondary injections.
4. **`nvidia/nemotron-3-ultra-550b-a55b`** (262k ctx | $0.625 / $3.125) — 550B MoE frontier open reasoning model for vulnerability search.
5. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Full-codebase taint tracking and dataflow analysis.

---

## Business and Personal

### Category 4 Workflows Overview

1. **Executive Decision Support & Strategic Planning:** Status Ingestion $\to$ Signal Extraction $\to$ Scenario Trade-Off Modeling $\to$ C-Suite Ghostwriting $\to$ Tone Calibration.
2. **Autonomous Personal Productivity & Task Automation:** Multi-Channel Ingestion $\to$ Urgency Triage $\to$ Action Item Extraction $\to$ Multi-Tool API Dispatch $\to$ Daily Briefing.
3. **High-Stakes Customer Escalation, Negotiation & Contracts:** Contract/Ticket Ingestion $\to$ SLA/Legal Risk Audit $\to$ Leverage (BATNA) Modeling $\to$ De-escalation Comms $\to$ Counter-Proposal Structuring.

---

### Workflow 4.1: Executive Decision Support & Strategic Planning

#### Role 4.1.1: Executive Intelligence Synthesizer & Ghostwriter

*Domain:* Distills messy operational data into dense, crisp, jargon-free executive narratives and board-level memos.

1. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Gold standard in executive prose; authoritative C-suite memos with zero fluff.
2. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Rapid daily drafting of executive summaries and decision briefs.
3. **`writer/palmyra-x5`** (1.04M ctx | $0.60 / $6.00) — Enterprise business corpus trained; low-cost long-form synthesis.
4. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Direct, unvarnished operational status reports.
5. **`openai/gpt-6-astra`** (1.05M ctx | $10.00 / $50.00) — High-stakes multi-entity corporate restructuring.

#### Role 4.1.2: Strategic Scenario & Moat Modeler

*Domain:* Analyzes capital allocation trade-offs, competitive moats (7 Powers), and down-side risk matrices.

1. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Game-theoretic modeling of competitor reactions and pricing power.
2. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Evaluates systemic industry dynamics and platform lock-in effects.
3. **`deepseek/deepseek-r1-0528`** (164k ctx | $0.50 / $2.15) — Pure chain-of-thought mathematical sensitivity analysis.
4. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — Macroeconomic supply chain disruption analysis across 1M context.
5. **`openai/gpt-6-astra`** (1.05M ctx | $10.00 / $50.00) — Multi-variable enterprise stress testing.

#### Role 4.1.3: Competitive Intelligence Web Researcher

*Domain:* Scans public databases, competitor releases, earnings calls, and patent filings to build factual dossiers.

1. **`perplexity/sonar-deep-research`** (128k ctx | $2.00 / $8.00) — Autonomous multi-step deep-web market research with live citations.
2. **`x-ai/grok-4.20-multi-agent`** (2M ctx | $1.25 / $2.50) — Real-time social, news, and market intelligence across 2M context.
3. **`perplexity/sonar-pro-search`** (200k ctx | $3.00 / $15.00) — Rapid multi-source competitive landscape synthesis.
4. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — Ingests competitor investor slide decks, financials, and whitepapers.
5. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Continuous automated monitoring of competitor site changes.

---

### Workflow 4.2: Autonomous Personal Productivity & Task Automation

#### Role 4.2.1: Operational Workflow Dispatcher & Tool Orchestrator

*Domain:* Invokes external APIs (calendar, email, CRM), coordinates webhooks, and manages background task pipelines.

1. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Sub-second deterministic tool dispatch with zero argument hallucination.
2. **`openai/gpt-5.6-sol`** (1.05M ctx | $2.00 / $10.00) — Complex multi-step tool dependency chaining and error recovery.
3. **`qwen/qwen3.6-flash`** (1M ctx | $0.1875 / $1.125) — High-throughput sub-second personal action router.
4. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Ambiguous user intent disambiguation.
5. **`google/gemini-3.1-pro-preview-customtools`** (1.05M ctx | $2.00 / $12.00) — Multi-agent tool orchestration.

#### Role 4.2.2: Cognitive Inbox & Communication Triager

*Domain:* Classifies incoming emails, extracts action items, prioritizes blockers, and drafts context-aware replies.

1. **`deepseek/deepseek-v4-flash-0731`** (1.31M ctx | $0.05 / $0.10) — High-volume Tier-0 spam/priority email triage at $0.05/M.
2. **`openai/gpt-5.6-luna`** (1.05M ctx | $0.20 / $1.20) — Fast structured JSON action item extractor from emails.
3. **`google/gemini-3.5-flash-lite`** (1.05M ctx | $0.30 / $2.50) — Multimodal attachment and PDF receipt processing.
4. **`mistralai/mistral-small-3.2-24b-instruct`** (131k ctx | $0.075 / $0.20) — Private, fast thread summarization.
5. **`anthropic/claude-haiku-4.5`** (200k ctx | $1.00 / $5.00) — Escalation tier for sensitive VIP relationship messages.

#### Role 4.2.3: Daily Executive Concierge & Briefing Synthesizer

*Domain:* Aggregates meeting transcripts, daily agendas, and commitments into a prioritized morning briefing.

1. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Optimal balance of executive briefing tone, elegance, and cost.
2. **`upstage/solar-pro4`** (524k ctx | $0.03 / $0.12) — High-efficiency calendar, news, and slack backlog summarizer.
3. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — High-stakes executive priority briefing and talking points.
4. **`x-ai/grok-4.3`** (1M ctx | $1.25 / $2.50) — Fast morning social and industry pulse digest.
5. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Multimodal briefing compiling audio voicemails and visual slide decks.

---

### Workflow 4.3: High-Stakes Customer Escalation, Negotiation & Contracts

#### Role 4.3.1: Contract Redline & Commercial Terms Auditor

*Domain:* Audits 100-page MSAs, DPAs, and term sheets; flags aggressive indemnification, liability caps, and non-standard SLAs.

1. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Enterprise legal risk auditor; non-negotiable liability clause verification.
2. **`writer/palmyra-x5`** (1.04M ctx | $0.60 / $6.00) — Purpose-built contract language and indemnification clause analyzer.
3. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Contextual commercial terms and dispute resolution redlines.
4. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — Long 1M-token cross-contract reconciliation.
5. **`openai/gpt-6-astra`** (1.05M ctx | $10.00 / $50.00) — Cross-border regulatory compliance verification.

#### Role 4.3.2: Crisis & Customer De-escalation Communicator

*Domain:* Authors empathetic, authoritative, legally sound communications during outages, breaches, or disputes.

1. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Masterclass in diplomatic de-escalation, emotional intelligence, and trust restoration.
2. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Fast turnaround for high-pressure incident customer comms.
3. **`openai/gpt-6-astra`** (1.05M ctx | $10.00 / $50.00) — High-stakes enterprise SLA breach statements.
4. **`writer/palmyra-x5`** (1.04M ctx | $0.60 / $6.00) — Corporate PR and compliance-safe messaging.
5. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Direct, transparent post-mortem communication.

#### Role 4.3.3: Negotiation Leverage & Deal Structuring Strategist

*Domain:* Models counterparty BATNA, calculates walk-away thresholds, and structures tiered commercial counter-proposals.

1. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Game-theoretic concession modeling and BATNA optimization.
2. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Psychological leverage, interpersonal dynamics, and counter-framing.
3. **`deepseek/deepseek-r1-0528`** (164k ctx | $0.50 / $2.15) — Mathematical deal structure and incentive alignment analysis.
4. **`openai/gpt-5.6-sol`** (1.05M ctx | $2.00 / $10.00) — Term sheet covenant structuring.
5. **`openai/gpt-6-astra`** (1.05M ctx | $10.00 / $50.00) — Complex multi-party merger and joint venture dynamics.

---

## Architecture

### Category 5 Workflows Overview

1. **Distributed Systems Design & Technical RFC Formulation:** NFR/SLA Ingestion $\to$ System Topology & Trade-Offs $\to$ Technical RFC Authoring $\to$ STRIDE Threat Modeling $\to$ Storage/Sharding Design $\to$ IaC Cloud Topology $\to$ Chaos/DR Review $\to$ Independent Critic Quorum.

---

### Workflow 5.1: Distributed Systems Design & Technical RFC Formulation

#### Role 5.1.1: Principal Distributed Systems Architect

*Domain:* Evaluates CAP/PACELC trade-offs, consensus protocols (Raft, Sagas), partition boundaries, and authors primary RFCs.

1. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Designated architecture planner; strict fault domain and consensus design.
2. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Formal proof of consensus safety, liveness, and split-brain recovery logic.
3. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Multi-tier cloud topology and global multi-region architecture design.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Publication-grade RFC authoring detailing operational trade-offs and team boundaries.
5. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Cost-effective evaluation of microservice communication topologies.

#### Role 5.1.2: Scalability & Database Topology Specialist

*Domain:* Designs relational/NoSQL schemas, horizontal sharding keys, caching topologies (Redis/Valkey), and zero-downtime migration plans.

1. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Primary workhorse for high-scale sharding and replication modeling.
2. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Distributed multi-master database topology and write-conflict resolution.
3. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Strict consistency vs eventual consistency boundary auditing.
4. **`qwen/qwen3.8-2.4t-a95b`** (1.05M ctx | $2.00 / $6.00) — Partitioning, indexing, and high-throughput query topology.
5. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Pragmatic cache tiering (Redis/Dragonfly) and read-replica strategies.

#### Role 5.1.3: Security Architect & Threat Modeler

*Domain:* Conducts STRIDE threat assessments, reviews IAM least-privilege policies, mTLS boundaries, and zero-trust architectures.

1. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Designated architecture/permissions critic; zero-trust network modeling.
2. **`openai/gpt-5.6-sol`** (1.05M ctx | $2.00 / $10.00) — Designated CLI/spec critic; auth token and protocol threat analysis.
3. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Enterprise IAM and cloud privilege escalation modeling.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — STRIDE threat matrix synthesis and compliance verification.
5. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Full-infrastructure vulnerability surface analysis.

#### Role 5.1.4: Infrastructure as Code (IaC) & Cloud Topology Engineer

*Domain:* Generates declarative Terraform/OpenTofu, Pulumi, Kubernetes CRDs, and VPC networking definitions.

1. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Fast, deterministic Terraform/Kubernetes manifest implementation.
2. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — 1M context whole-infrastructure state dependency resolution.
3. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Complex cloud provider networking and peering configurations.
4. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — High-speed validation of cloud resources and linting.
5. **`mistralai/devstral-2512`** (262k ctx | $0.40 / $2.00) — Lightweight Helm chart and Docker Compose generator.

#### Role 5.1.5: Reliability, Chaos & Disaster Recovery Reviewer

*Domain:* Evaluates single points of failure, RPO/RTO metrics, cascading timeouts, circuit breakers, and active-active failovers.

1. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — Principal disaster recovery and cascading failure reviewer.
2. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Probabilistic modeling of MTTR, MTBF, and network partition recovery.
3. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Full-topology chaos injection scenario planning.
4. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Multi-region disaster recovery runbook formulation.
5. **`moonshotai/kimi-k3`** (1.05M ctx | $3.00 / $15.00) — Cross-datacenter failover verification.

#### Role 5.1.6: Architecture Critic & Protocol Auditor

*Domain:* Independent peer-review; challenges unvalidated assumptions, prevents architectural drift, and verifies contracts.

1. **`anthropic/claude-fable-5.1`** (1M ctx | $10.00 / $50.00) — **Designated Architecture & Permissions Critic** (Mandatory for PR acceptance).
2. **`openai/gpt-5.6-sol`** (1.05M ctx | $2.00 / $10.00) — **Designated CLI, Protocol & Contracts Critic** (Mandatory for PR acceptance).
3. **`z-ai/glm-5.3`** (1.31M ctx | $1.40 / $4.40) — 1.31M context full-stack protocol audit.
4. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Enterprise RFC compliance verification.
5. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — Independent open-weights architectural validation.

---

## Analytics

### Category 6 Workflows Overview

1. **Enterprise Business Intelligence & Text-to-SQL Pipeline:** Metric Resolution $\to$ SQL Generation $\to$ AST Optimization $\to$ Warehouse Execution $\to$ Declarative Dashboard Formatting.
2. **Automated Data Science & Statistical Modeling:** Data Hygiene $\to$ Hypothesis Formulation $\to$ Vectorized Python (Polars/Pandas) $\to$ Sandbox Execution $\to$ Causal Inference.
3. **Multimodal Financial & Operational Document Intelligence:** Massive 10-K Ingestion $\to$ Table/Chart Extraction $\to$ High-Precision Mathematical Auditing $\to$ Executive Variance Memo.
4. **Real-Time Operational Telemetry & Distributed Systems RCA:** High-Throughput Log Filtering $\to$ Anomaly Clustering $\to$ Causal Reconstruction $\to$ Post-Mortem Synthesis.

---

### Workflow 6.1: Enterprise Business Intelligence & Text-to-SQL Pipeline

#### Role 6.1.1: Semantic Schema Resolver & Text-to-SQL Architect

*Domain:* Translates natural language questions into performant SQL queries (CTEs, window functions) across enterprise warehouses.

1. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Complex nested SQL queries, CTEs, and window functions.
2. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — Ingests 1,000-table enterprise data dictionaries in 1M context.
3. **`deepseek/deepseek-v4-pro`** (1.05M ctx | $0.63 / $1.25) — High-throughput Text-to-SQL generation.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Ambiguous business metric semantic translation.
5. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Ultra-fast schema resolution and join mapping.

#### Role 6.1.2: SQL Query Optimizer, Validator & Self-Correction Agent

*Domain:* Inspects `EXPLAIN ANALYZE` query plans, eliminates Cartesian products, and applies dialect-specific index optimizations.

1. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Query execution plan optimization and index utilization logic.
2. **`deepseek/deepseek-r1-0528`** (164k ctx | $0.50 / $2.15) — High-efficiency algorithmic query rewriting.
3. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Database engine-specific syntax correction (Postgres/Snowflake/BigQuery).
4. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — Cost-efficient automated query correction loop.
5. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Enterprise data governance and query compliance.

#### Role 6.1.3: Executive BI Visualization & Dashboard JSON Formatter

*Domain:* Transforms SQL result tables into declarative chart specifications (Vega-Lite, ECharts) with executive commentary.

1. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Visual chart layout and structured Vega-Lite/ECharts JSON.
2. **`qwen/qwen3.8-flash`** (1M ctx | $0.15 / $0.47) — Ultra-fast, low-cost dashboard widget JSON generation.
3. **`z-ai/glm-5.3-flash`** (1.31M ctx | $0.075 / $0.25) — High-throughput dashboard data series formatting.
4. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Executive visual narrative and metric layout design.
5. **`openai/gpt-5.6-sol-pro`** (1.05M ctx | $2.00 / $10.00) — Strict schema compliance for BI embedded frameworks.

---

### Workflow 6.2: Automated Data Science & Statistical Modeling

#### Role 6.2.1: Data Science Sandbox Code Synthesizer (Python/Polars/Pandas)

*Domain:* Writes vectorized, performant Python code for feature engineering, statistical modeling, and ML pipelines.

1. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Complex numerical analysis, PyTorch/Scikit pipelines.
2. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — High-capacity Python data science code generator with 1M context.
3. **`mistralai/codestral-2508`** (256k ctx | $0.30 / $0.90) — Extremely low-cost Polars/Pandas data pipeline implementation.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Complex econometric and Bayesian model formulation.
5. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Large-scale data ingestion and transformation scripts.

#### Role 6.2.2: Statistical Anomaly, Causal Inference & Distribution Reasoner

*Domain:* Evaluates p-values, separates correlation from causation, controls for confounders, and diagnoses distribution drift.

1. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Advanced causal inference, covariate adjustment, and distribution shift reasoning.
2. **`deepseek/deepseek-r1-0528`** (164k ctx | $0.50 / $2.15) — High-efficiency statistical hypothesis testing and anomaly deduction.
3. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Interpreting causal models for business decision-makers.
4. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — Ingestion of multimodal data distribution plots and correlations.
5. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Enterprise-scale econometric simulation.

---

### Workflow 6.3: Multimodal Financial & Operational Document Intelligence

#### Role 6.3.1: Massive-Context Multimodal Financial Dossier Extractor

*Domain:* Ingests 100k–1M+ token SEC 10-K/10-Q filings and investor decks; extracts dense tables and footnotes without OCR degradation.

1. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Premier unit economics for 1M-token PDF table and chart extraction.
2. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — Footnote reconciliation and complex accounting table extraction.
3. **`qwen/qwen3.8-max-0902`** (1M ctx | $2.00 / $6.00) — Robust bilingual financial reporting and balance sheet analysis.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Qualitative MD&A disclosure risk synthesis.
5. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Low-cost long-form structured financial data normalization.

#### Role 6.3.2: High-Precision Financial Math & Variance Auditor

*Domain:* Reconciles statement equations, verifies debt covenants, and recalculates financial ratios with zero arithmetic error.

1. **`openai/o3`** (200k ctx | $2.00 / $8.00) — Zero-hallucination arithmetic audit and ledger balance reconciliation.
2. **`deepseek/deepseek-r1-0528`** (164k ctx | $0.50 / $2.15) — High-speed variance detection and formula recalculation.
3. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Full financial audit report synthesis and regulatory commentary.
4. **`openai/gpt-5.6-sol-pro`** (1.05M ctx | $2.00 / $10.00) — Audit compliance verification against accounting standards.
5. **`openai/gpt-6-astra-pro`** (1.05M ctx | $10.00 / $50.00) — Complex tax and holding company consolidation.

---

### Workflow 6.4: Real-Time Operational Telemetry & Distributed Systems RCA

#### Role 6.4.1: High-Throughput Telemetry Stream Parser & Anomaly Classifier

*Domain:* Ingests high-velocity JSON logs, OpenTelemetry traces, and time-series metrics at rock-bottom token cost.

1. **`qwen/qwen3.7-flash`** (1M ctx | $0.03 / $0.13) — **Tier-0 Primary Streaming Gate**; 1M context at $0.03/M prompt.
2. **`deepseek/deepseek-v4-flash-0731`** (1.31M ctx | $0.05 / $0.10) — High-throughput anomaly classification in 1.31M context.
3. **`z-ai/glm-5.3-flash`** (1.31M ctx | $0.075 / $0.25) — High-speed log aggregation and pattern recognition.
4. **`google/gemini-3.1-flash-lite`** (1.05M ctx | $0.25 / $1.50) — Multimodal metric graph and trace ingestion.
5. **`amazon/nova-2-lite-v1`** (1M ctx | $0.30 / $2.50) — Resilient secondary cloud telemetry classifier.

#### Role 6.4.2: Distributed Systems RCA & Incident Debrief Synthesizer

*Domain:* Traces microservice failure cascades, determines primary failure mechanisms, and authors post-mortems.

1. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Unmatched incident debrief authoring, timeline reconstruction, and learnings.
2. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — High-velocity technical post-mortem report writer.
3. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Root cause extraction without corporate sugarcoating.
4. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Visual timeline generation combining metric spikes and log traces.
5. **`deepseek/deepseek-v4-pro-0813`** (1.05M ctx | $0.58 / $1.74) — Infrastructure remediations and preventive patch specification.

---

## UI/UX Design for Web, Mobile and TUI Interfaces

### Category 7 Workflows Overview

1. **Design System Architecture & Multi-Platform Component Engineering:** W3C DTCG Token Modeling $\to$ Style Dictionary v4 AST Engine $\to$ Headless Component Primitives $\to$ Compound Variants (CVA).
2. **Mobile-First Interactive UX & Gesture/Haptic Engineering:** Harmonic Spring Physics $\to$ Reanimated v3 UI-Thread Worklets $\to$ SwiftUI/Compose Gestures $\to$ CoreHaptics Waveforms $\to$ 120Hz LTPO Profiling.
3. **Terminal User Interface (TUI) & Rich CLI Experience Engineering:** Raw Mode Protocol $\to$ TrueColor Double-Buffering $\to$ The Elm Architecture (Bubbletea) / Ratatui Layouts $\to$ Terminal Signal Trapping.
4. **Multimodal Visual Design QA, Accessibility (a11y) & Polish Audit:** Snapshot Ingestion $\to$ Perceptual Diffing (SSIM) $\to$ WCAG 2.2 / APCA Contrast Math $\to$ Concentric Radius / Optical Polish.

---

### Workflow 7.1: Design System Architecture & Multi-Platform Component Engineering

#### Role 7.1.1: Design Token & Multi-Platform Theme Architect

*Domain:* W3C DTCG token schema authoring, Style Dictionary v4 AST pipelines, OKLCH/Display-P3 scales, and multi-platform packaging (Web, Swift, Compose).

1. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Master design token taxonomist; color space (OKLCH) and scale hierarchy.
2. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Multi-platform token transformation (W3C Design Tokens to CSS/iOS/Android).
3. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — Monorepo theme implementation and code generation.
4. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Fast token validation and contrast ratio auditing.
5. **`openai/gpt-5.4`** (1.05M ctx | $2.50 / $15.00) — Enterprise design system cross-platform consistency.

#### Role 7.1.2: Web Component & Interaction Synthesizer (React/Tailwind/Radix)

*Domain:* Modern React 19, Tailwind CSS v4 `@theme`, Radix UI headless primitives, polymorphic slot patterns, and CVA variant systems.

1. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Clean React 19, Tailwind, and accessible Radix/Aria primitives.
2. **`bytedance-seed/seed-2.0-code`** (262k ctx | $0.50 / $3.00) — Highly efficient component code synthesizer.
3. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Fast state machine implementation and micro-interaction code.
4. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Complex layout virtualization and DOM performance tuning.
5. **`deepseek/deepseek-v4-pro`** (1.05M ctx | $0.63 / $1.25) — Bulk UI component library scaffolding.

---

### Workflow 7.2: Mobile-First Interactive UX & Gesture/Haptic Engineering

#### Role 7.2.1: Mobile Native State & Micro-Interaction Engineer (SwiftUI/Compose/Reanimated)

*Domain:* Multi-touch gesture lifecycles, spring physics (stiffness, damping), 120Hz frame budgets, Reanimated v3 worklets, and native modifiers.

1. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Native mobile animation drivers, spring physics, and gesture recognizers.
2. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Fluid micro-interaction design and gesture state architecture.
3. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Fast mobile component implementation and state binding.
4. **`moonshotai/kimi-k2.7-code`** (262k ctx | $0.66 / $3.40) — Resilient mobile code generation.
5. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Mobile screen layout translation and asset mapping.

#### Role 7.2.2: Native Haptics & Hardware Integration Specialist (CoreHaptics/Vibrator)

*Domain:* Apple CoreHaptics (`.ahap` waveforms), Android `VibrationEffect` compositions, JSI hardware bridges, and tactile throttling.

1. **`mistralai/codestral-2508`** (256k ctx | $0.30 / $0.90) — Low-latency, precise hardware API bindings (Swift/Kotlin/C++).
2. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — High-throughput cross-platform haptic wrapper synthesizer.
3. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Fine-grained haptic feedback design and event mapping.
4. **`openai/gpt-5.4`** (1.05M ctx | $2.50 / $15.00) — Hardware sensor integration and battery lifecycle optimization.
5. **`openai/gpt-5.6-luna`** (1.05M ctx | $0.20 / $1.20) — Fast AHAP waveform JSON serialization.

---

### Workflow 7.3: Terminal User Interface (TUI) & Rich CLI Experience Engineering

#### Role 7.3.1: TUI Layout & ANSI Terminal Systems Engineer (Bubbletea/Ratatui/Ink)

*Domain:* Terminal emulation protocols (VT100, ANSI escape codes), TrueColor 24-bit rendering, alternate screens, and Ratatui constraint math.

1. **`x-ai/grok-4.6`** (500k ctx | $2.00 / $6.00) — Pragmatic terminal systems code writer; adheres to strict TUI layout constraints.
2. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Complex ANSI rendering engines and terminal buffer diffing.
3. **`poolside/laguna-s-2.1`** (1.05M ctx | $0.09 / $0.18) — **Terminal-Bench 2.1 Specialist (70.2% score)**; 1M context at $0.09/M.
4. **`mistralai/devstral-2512`** (262k ctx | $0.40 / $2.00) — Clean Go (Bubbletea) and Rust (Ratatui) view/update implementations.
5. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — High-ergonomic terminal UX and keyboard navigation design.

#### Role 7.3.2: Terminal Event Loop & Keyboard Navigation Specialist (TEA/Tokio/Raw Mode)

*Domain:* The Elm Architecture (TEA) in Bubbletea, Tokio event loops in Rust, raw mode stdin demuxing, Vim modal keymaps, and signal trapping.

1. **`openai/gpt-5.3-codex`** (400k ctx | $1.75 / $14.00) — Flawless asynchronous event loop (Tokio/TEA) and POSIX termios handling.
2. **`openai/gpt-5.6-sol`** (1.05M ctx | $2.00 / $10.00) — Flagship CLI and sub-process navigation specialist; signal cleanup.
3. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — High-precision Rust/Go async event handling and state dispatch.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Complex modal keybinding architectures (Vim/Emacs emulation).
5. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Clean command routing and keyboard navigation schemas.

---

### Workflow 7.4: Multimodal Visual Design QA, Accessibility (a11y) & Polish Audit

#### Role 7.4.1: Multimodal Visual QA & Aesthetic Polish Auditor

*Domain:* High-resolution screenshot vs Figma spec comparisons, optical alignment, typography baseline grids, and concentric nested radii math.

1. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — **Primary Automated Visual QA Gate**; rapid visual diff and layout regression detection.
2. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — High-precision design system aesthetic fidelity and alignment audit.
3. **`qwen/qwen3-vl-235b-a22b-instruct`** (262k ctx | $0.21 / $1.90) — Ultra-low-cost screenshot artifact and font rendering detector.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Final qualitative visual polish and brand aesthetic signoff.
5. **`google/gemini-3.1-pro-preview`** (1.05M ctx | $2.00 / $12.00) — High-resolution pixel-perfect design-to-code comparison.

#### Role 7.4.2: Cognitive Accessibility (a11y) & WCAG Compliance Specialist

*Domain:* WCAG 2.2 AA/AAA success criteria, APCA contrast math, accessibility tree DOM verification, focus traps, and axe-core test automation.

1. **`anthropic/claude-sonnet-5`** (1M ctx | $2.00 / $10.00) — Gold standard for semantic HTML, ARIA tree hierarchies, and focus management.
2. **`google/gemini-3.8-flash`** (1.05M ctx | $0.75 / $3.75) — Automated WCAG 2.2 color contrast and visual touch-target auditor.
3. **`qwen/qwen3-coder-plus`** (1M ctx | $0.65 / $3.25) — High-throughput AST accessibility linter and automated ARIA fixer.
4. **`anthropic/claude-opus-5`** (1M ctx | $5.00 / $25.00) — Cognitive load and neurodiverse accessibility compliance evaluation.
5. **`openai/gpt-5.4`** (1.05M ctx | $2.50 / $15.00) — Screen-reader script simulation and compliance reporting.

---

## Strategic Implementation and Execution Checklist

1. **Deterministic Developer Gate Alignment:** Code implementations (backend, frontend, TUI, build tools) are routed to **`x-ai/grok-4.6`** ($2.00/$6.00) and **`qwen/qwen3-coder-plus`** ($0.65/$3.25) as primary writers, ensuring they pass deterministic verification gates (`npm run verify`) without hitting high-cost completion penalties.
2. **Mandatory Dual-Critic Acceptance Quorum:** All architecture, PR, and specification reviews require independent signoff from the designated critic pair:
   - **`anthropic/claude-fable-5.1`** (Architecture & Permissions)
   - **`openai/gpt-5.6-sol`** (CLI, Protocol & Contracts)
3. **Automated Tier-0 Filter Gating:** High-throughput streaming ingestion (logs, telemetry, video frames, email batch) must pass through Tier-0 models (**`deepseek/deepseek-v4-flash-0731`** at $0.05/M or **`qwen/qwen3.7-flash`** at $0.03/M) to filter 90% of noise before escalating to deep reasoning models.
4. **Context Safety Ceiling:** Models with $\le 200\text{k}$ context (**`openai/o3`**, **`deepseek/deepseek-r1-0528`**) must only receive pre-distilled inputs ($\le 100\text{k}$ tokens) to guarantee zero context-overflow exceptions during production runs.
