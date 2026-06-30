import { ModelID } from '@industry/drool-sdk-ext/protocol/llm';

// TODO(industry-router): refresh for Opus 4.8 (inherited from Opus 4.6).
const OPUS_CARD = `capabilities: images (full support), extended reasoning, multi-file edits, iterative debugging, error recovery, sub-agent orchestration

strengths: Excels at sustained reasoning across many files, plan-then-execute workflows, and recovery from errors. Strong areas:
- Security & cryptanalysis: forensic password recovery, differential cryptanalysis, vulnerability analysis
- Java 7 binary/legacy formats: proprietary binary parsing, CDR processing, packed decimals
- ML/data science: cross-framework migration (e.g. RStan→PyStan), model inference setup, model architecture recovery
- Complex build systems: legacy C/C++ builds, OCaml/Coq toolchains, niche compiler bootstrapping
- Git archaeology: history sanitization, forensic recovery from rewritten or deleted refs
- Algorithm implementation: eigenvalue solvers, constraint satisfaction, Bayesian network structure learning

weaknesses: Significant weaknesses in legacy/low-level languages and tasks requiring extreme precision:
- COBOL/mainframe: cannot reliably produce fixed-format COBOL, EBCDIC encoding, or correct financial calculations. Migrations to other languages lose business logic precision.
- x86-64 assembly: fails to produce correct assembly files or generates incorrect register usage for protocol parsers and hardware validators.
- Fortran 77 scientific computing: nuclear physics simulations, Monte Carlo photon transport, and eigenvalue solvers in Fortran are beyond capability.
- C89 systems programming: MLFQ schedulers, binary codecs, transport protocols, VT100 emulators in strict C89.
- Video/media analysis: frame-level temporal detection, video-to-text transcription with high similarity thresholds
- Tight numerical tolerances: tasks where the answer is close but just outside strict acceptance thresholds (hyperparameter tuning, spectral fitting, primer design)
- HTML normalization traps: tasks requiring byte-identical output preservation — parsers normalize whitespace and entities

score_examples:
- "Recover a deleted secret from repository history and scrub all refs" → 0.97 (forensic git recovery is a core strength)
- "Fix a legacy Java binary format parser producing wrong financial totals" → 0.91 (proprietary binary format debugging strength)
- "Fix a compiler's garbage collector after a storage format change" → 0.98 (compiler internals strength)
- "Implement a chosen-plaintext cryptanalytic attack to recover a cipher key" → 0.97 (cryptanalysis strength)
- "Fix a COBOL payroll system producing incorrect net payroll" → 0.15 (COBOL business logic is a blind spot — compiles but wrong deductions)
- "Write x86-64 assembly for an industrial protocol register parser" → 0.10 (assembly generation fails completely)
- "Implement Monte Carlo particle transport in Fortran 77" → 0.05 (Fortran + physics simulation: double weakness)
- "Train a text classifier to a specific accuracy threshold" → 0.25 (hyperparameter sensitivity — gets close but misses tight thresholds)
- "Strip scripting from markup while preserving untouched files byte-identical" → 0.10 (parsers normalize whitespace/entities, breaking identity checks)
- "Extract temporal metrics from a video recording" → 0.15 (frame-level detection off by small amounts, below strict thresholds)
- "Write a polyglot file valid in two different languages" → 0.45 (code works but environmental cleanup issues)
- "Build a gRPC server with standard CRUD operations" → 0.98 (standard infrastructure, near-certain success)
- "Find a valid time slot satisfying multiple calendar constraints" → 0.98 (constraint satisfaction strength)`;

// TODO(industry-router): refresh for Kimi K2.7.
const KIMI_CARD = `capabilities: images (basic support), tool calling, single-file edits, grep/read/test loops, checklist execution

strengths: Fast and effective on well-scoped tasks with clear, conventional solution paths:
- Standard server/infra: gRPC servers, Nginx, OpenSSL certs, package hosting
- Git operations: recovering lost changes, leaked secrets from history
- Standard ML ops: model inference, PyTorch CLI, MCMC/Stan sampling
- Data processing: log summarization, multi-source merging, CSV transforms
- Code migration: Python 2→3, standard COBOL modernization
- Formal proofs: well-known patterns (e.g. commutativity in Coq)
- Constraint satisfaction: scheduling, portfolio optimization

weaknesses: Consistently fails on tasks requiring sustained multi-step reasoning, iterative debugging, or deep domain expertise. Specific failure areas:
- COBOL/mainframe: EBCDIC encoding, VSAM handling, complex financial calculations
- Java 7 proprietary binary formats: packed decimals, CDR processing, telecom protocols (code compiles but produces wrong values)
- x86-64 assembly: protocol parsers, hardware validators
- Fortran scientific computing: nuclear physics, Monte Carlo methods, modal analysis
- C89 systems programming: MLFQ schedulers, binary codecs, transport protocols
- Security/exploit tasks: XSS bypass, cryptanalysis, exploit development
- Domain-specific science: DNA primer design, Raman spectroscopy, protein FRET, cell segmentation
- Graphics/ray tracing: pixel-accurate path tracing, gcode interpretation
- Complex build systems: niche compiler builds (CompCert, pMARS), cross-compilation for exotic targets
- PyTorch distributed: pipeline parallelism, tensor parallelism
- Polyglot files: writing single files valid in two languages

score_examples:
- "Summarize log files by date range into a CSV" → 0.95 (standard data processing strength)
- "Build a gRPC server with standard CRUD operations" → 0.95 (standard server/infra strength)
- "Configure a web server with custom request logging" → 0.85 (standard server/infra strength)
- "Install RStan and sample a hierarchical Bayesian model" → 0.85 (standard ML ops strength)
- "Find a valid time slot satisfying multiple constraints" → 0.80 (constraint satisfaction strength)
- "Recover a secret from rewritten git history" → 0.80 (git operations strength)
- "Reconstruct a PyTorch model architecture from a state dict" → 0.75 (standard ML ops, some complexity)
- "Implement a statistical sampling algorithm from a paper" → 0.50 (multi-step algorithm, subtle edge cases)
- "Build native extensions for a Python package" → 0.45 (complex build systems weakness)
- "Remove secrets from a git repo across all history" → 0.35 (requires full-history rewriting beyond standard git)
- "Fix an OCaml garbage collector after a storage format change" → 0.35 (compiler internals, sustained debugging weakness)
- "Fix a legacy Java binary format parser producing wrong financial totals" → 0.15 (proprietary binary formats weakness)
- "Implement a chosen-plaintext cryptanalytic attack" → 0.10 (security/exploit weakness)
- "Design molecular biology primers for gene insertion" → 0.05 (domain-specific science weakness)
- "Write x86-64 assembly for an industrial protocol parser" → 0.05 (x86-64 assembly weakness)`;

// TODO(industry-router): refresh for MiniMax M3.
const MINIMAX_CARD = `capabilities: images, tool calling, single-file edits, grep/read/test loops, checklist execution

strengths: Fast and effective on well-scoped single-file tasks with clear instructions, standard test loops, and short Q&A.

weaknesses: Unreliable on multi-file refactors, subtle debugging, long reasoning chains, niche toolchains, and tasks requiring deep domain knowledge. Similar weakness profile to other non-flagship models; see specific struggle areas for comparable models.`;

export const MODEL_CARDS: Readonly<Partial<Record<ModelID, string>>> =
  Object.freeze({
    [ModelID.CLAUDE_OPUS_4_8]: OPUS_CARD,
    [ModelID.KIMI_K2_7_CODE]: KIMI_CARD,
    [ModelID.MINIMAX_M3]: MINIMAX_CARD,
  });
