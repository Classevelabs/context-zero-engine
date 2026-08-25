# Context Zero Engine — Benchmarks

## Headline (2.10.0, measured 2026-08-25)

Two numbers have to be true at once. The context has to be small, and it has to
still carry what the change depends on. A reduction on its own proves nothing —
returning an empty response is a 100% reduction — so both are measured from the
same run, on 400 randomly selected functions, methods and classes in a private
375k-LOC production monorepo, with the capsule pinned to the 8,000-token budget
the tool actually defaults to.

Ground truth comes off disk, not out of the graph: the target's body is re-read
by line range, the defining file's imports are resolved through the workspace's
own `package.json` export maps, and a dependency counts when a name the body
actually uses resolves to a real file in the repository. Both sides draw on the
same universe of files — the ones the index covers — so neither is credited for
reach the other never had.

### What it carries, at an identical budget

The baseline greps for the symbol and reads the matching files best-first,
charged nothing for the search and nothing for deciding what to open, spending
exactly the tokens the capsule spent.

| At an identical token budget | ContextZero | Reading the files |
|---|---:|---:|
| Has the implementation | **100%** | 19% |
| Has the interface | **100%** | 19% |
| Has a caller, verified against its own source | **75–78%** | 27–32% |
| Cross-file imports the body uses, delivered | **48–54%** | ~0% |
| Of those the index has edges for | **58–63%** | — |
| Checkable facts per 1,000 tokens | **1.26–1.35** | 0.23 |
| Tasks won / tied / lost | **145–169 / 231–255** | **0** |

The ~0% is not a rigged baseline. The average capsule now costs ~2,900 tokens,
and at 2,900 tokens a grep-driven agent can afford at most one file — usually a
test file, not the definition. Grep finds where a name is used; it does not find
what that name needs.

### What it costs

| Pooled over 400 tasks | Value |
|---|---:|
| Average capsule | **2,637–2,955 tokens** of an 8,000 budget |
| Reduction vs. grep-and-read (top 25 files) | **9.8–12.9x** |
| Reduction vs. an oracle reading exactly the right files | **7.1–9.7x** (median 3.5–3.9x) |
| Capsules exceeding their stated budget | **0–3 of 400**, never by more than a few tokens |
| Capsule's own `token_estimate` vs. bytes actually shipped | **99.5%** |
| Capsule compile, mean / p90 | 38 ms / 40 ms |

The oracle is the comparison that matters: it is told in advance which files
carry the dependencies the capsule delivered, pays nothing to search, and pays
for no dead ends. The capsule beats it seven- to ten-fold pooled and roughly
four-fold on the median task.

### What was fixed to get here

The previous 2.9.0 measurement found the engine spending roughly half of every
capsule on waste. Those numbers were published in this file rather than hidden;
this table is the same measurement after the repair, same corpus, same method,
400 tasks per run.

| Measured on the shipped capsule | 2.9.0 | Now |
|---|---:|---:|
| Average capsule size (8,000 budget) | 7,825 tokens | **2,861 tokens** |
| Capsules blowing their budget | 203 / 400 | **0–3 / 400** |
| Self-reported size vs. actual | 40.7% | **99.5%** |
| Context nodes that repeated an earlier node | 28.5% | **0%** |
| Capsule tokens spent on effect entries | 39.3% | **2.2%** |
| Of shipped effect entries, cycle-propagated | 98.6% | **0.5%** |
| Cross-file imports delivered | 43.7% | **48–54%** |
| Facts per 1,000 tokens | 0.46 | **1.26–1.35** |
| Reduction vs. oracle | 3.0x | **7.1–9.7x** |

Four defects, all in the shipping path, none in the ideas:

1. **The effect engine's "cycles" were not cycles.** Symbols skipped by the
   acyclic propagation pass were clustered by breadth-first search over *both*
   edge directions — weak connectivity — so two functions that merely shared a
   caller inside some cycle were fused, and on this monorepo nearly every
   leftover symbol landed in one giant cluster whose unioned effects were
   stamped onto every member. 696,940 of the snapshot's 703,997 effect entries
   (99.0%) were that photocopy, and 6,021 functions were mislabelled maximally
   side-effecting. The recovery now computes true strongly connected components
   (iterative Tarjan) and walks them sinks-first, so only genuine mutual
   recursion shares a fate and cross-component effects arrive with honest hop
   counts. After re-ingest: **36** cycle entries survive, 153 functions carry
   the maximal label, and the average non-empty signature holds 2.1 entries
   instead of 88.

2. **Every dependency was pasted twice.** The extractor records both a `calls`
   and a `references` edge for the same pair — calling a function is also
   referencing it — and the capsule's loaders selected relation *rows*, not
   distinct symbols. The same dependency arrived twice at full source and
   consumed two slots of the load limit. The loaders now select one row per
   symbol (strongest relation wins: a call outranks a type usage outranks a
   mention), and a symbol whose source is already in the capsule is never
   pasted again — a repeat ships as a one-line signature.

3. **The capsule could not count its own size.** The budget loop summed the
   raw text of the pieces it chose and ignored everything else that shipped:
   JSON structure, the full effect array (attached after budgeting), and a
   per-node bookkeeping ledger. Capsules reported ~40% of their true size and
   half of them overshot the budget they claimed to honor. Every piece is now
   priced at its serialized byte cost — the unit that actually ships — the
   bookkeeping ledger is persisted to the database instead of being billed to
   every consumer, and a final measured pass guarantees the total. Related:
   sizes were previously measured in UTF-16 code units, which under-counts
   unicode-heavy source by up to half again.

4. **Effects shipped twice, uncounted.** A formatted effect summary node was
   added inside the budget and the entire raw entry array was attached outside
   it. One representation ships now — deduplicated by kind and descriptor,
   direct observations first, the transitive tail capped at 15 entries by hop
   count — and it is priced like everything else.

The same serialized-cost accounting was applied to `scg_smart_context`, which
had the milder form of the same disease (source text counted, ten metadata
fields per entry free, up to 500 omission strings shipped uncounted).

### Correction: the 33.9x headline is withdrawn

The 2.9.0 release claimed 33.9x and 97.1% savings. That script reproduces —
it still prints 35.8x — but the number is an artifact of the machine it ran on,
not of the engine. The baseline grepped the repository directory as it found
it, and that directory contained `.claude/worktrees`: duplicate checkouts of
the same source tree. Measured on the same 40 symbols with the same top-25
rule, **73.8% of the files that baseline "read" were duplicate copies of files
it had already read**, inflating the baseline 10.3x (12,398 files on disk,
2,942 in the index). The current benchmark restricts both sides to the indexed
universe, which is why today's honest ratios — 9.8–12.9x against grep-and-read
— are both smaller than the withdrawn number and larger than the 3.7x this file
briefly reported while the capsule was still carrying its own waste.

## Where it is still weak

Measured in the same runs, stated as plainly as the wins:

- **Half the missing dependencies have no edge at all.** Of the body-used
  imports the capsule failed to deliver, 69% have no relation row anywhere in
  the graph — dominated by namespace-style bindings (`import { Session } …;
  Session.get(...)`) whose named declaration is not indexed as a symbol, so
  relation resolution has nothing to attach the reference to. This is now the
  single largest recall ceiling, it lives in extraction rather than selection,
  and raising the dependency load limit from 40 to 80 measurably changed
  nothing — the loader is not the bottleneck.
- **Budget utilization is ~36%.** Capsules stop at ~2,900 of 8,000 tokens not
  out of thrift but because the graph has nothing further to offer for the
  target. Fixing the extraction gap above is what converts the unspent budget
  into delivered dependencies.
- **A quarter of capsules name no verified caller** (75–78% do). Test linkage
  is worse: a linked test ships in ~5% of capsules.
- **Effect coverage halved and got honest.** 48.5% of capsules carry an effect
  signature (was 63.7% when the blob padded everyone); what ships is 24.4%
  read from the function's own body, the rest transitive with hop counts, and
  0.5% is cycle residue.

### The same engine on a second corpus

A 2,443-file mixed-language working directory — scripts, release trees, a
website, this engine itself — re-ingested with the same fixed engine, 250
tasks, same method. Different shape, same behavior:

| | Monorepo (400 tasks) | Mixed corpus (250 tasks) |
|---|---:|---:|
| Average capsule | ~2,900 tokens | **1,379 tokens** |
| Reduction vs. grep-and-read | 9.8–12.9x | **29.9x** |
| Reduction vs. the oracle | 7.1–9.7x | **8.5x** |
| Cross-file imports delivered | 48–54% | **57%** |
| Of those the index has edges for | 58–63% | **57%** |
| Has a verified caller | 75–78% | 17.6% |
| Capsules over budget | 0–3 / 400 | **0 / 250** |
| `token_estimate` vs. actual | 99.5% | **99%** |
| Facts per 1,000 tokens | 1.26–1.35 | **1.71** |

On this corpus overall recall and indexed recall are the same number — the
current extractor indexes every body-used import here, so what remains is
purely the selection path. The low caller rate is the corpus, not the engine:
a directory of scripts and release snapshots genuinely has few callers to find.

### Variance

Sampling 400 random symbols per run: cross-file recall 47.6% / 49.2% / 50.9% /
53.8% across four runs; oracle reduction 7.1x / 7.7x / 8.4x / 9.7x. A few
points of run-to-run movement is expected; single small-sample runs are not
reliable.

### Reproduce

```bash
node scripts/bench-context-quality.mjs 400 /path/to/your/indexed/repo
```

The repository must already be ingested (re-ingest on 2.10.0 or later
so the effect-propagation fix reaches the stored signatures). The script
re-reads ground truth from disk, resolves imports through workspace manifests,
and prints every number above as JSON, including the weak ones.

---

This document also records earlier author-reported benchmark runs: a
self-ingest run, a large-repository run on VS Code, and a multi-language run
across seven open-source projects. The benchmark scripts are in [`scripts/`](scripts/),
but the original raw machine-readable outputs and database snapshots are not
committed. Those older tables are historical claims and reproduction
targets, not independently verifiable release evidence or guaranteed field
performance.

**Read every reduction ratio below against the correction above.** Each of them
uses a grep-and-read baseline over whatever source files sat in the target
directory, and none of them checked that directory for duplicate copies of the
same tree. Where a repository was cloned clean the figure is unaffected; where
it was not, the baseline was inflated by however many copies were present. The
quality columns — implementation, interface, caller — are unaffected either way,
because they are properties of one capsule rather than of the pool it was
compared against.

**Hardware note.** All measurements were taken on a typical mid-range
developer laptop (quad-core x86-64), no server hardware and no clustering.
The historical runs below used PostgreSQL 16 and Node.js 22; the 2.6.0 ingest
figures above used PostgreSQL 17 and Node.js 24. Absolute timings and reduction
ratios can vary with corpus revision, selected symbols, disk, CPU, database
configuration, and current engine version.

---

## Methodology

- **Token policy**: tokens are estimated as `ceil(bytes / 4)`. This is a
  deterministic approximation chosen for repeatability — exact tokenizer
  counts differ by model, but the ratios hold.
- **Whole-source baseline**: read every source/document file in the target
  repository into context.
- **Exact-symbol baseline**: find every source/document file containing the
  exact symbol name (grep) and read those files into context. This is the
  stricter, more realistic baseline and the one to pay attention to.
- **ContextZero**: compile one strict context capsule for the same symbol
  (source + dependencies + contracts + effects, token-budgeted).
- A human or agent with good judgment could read fewer files than the
  baseline — or far more when manually tracing transitive dependencies.
  The baselines are defined so the comparison is mechanical and re-runnable.

---

## Current Ingest Throughput (2.6.0)

One full clean ingest, measured on 2026-08-20 against an empty database on the
hardware described above (PostgreSQL 17, Node.js 24):

| Measure | Value |
|---|---:|
| Files indexed | 2,637 |
| Files failed | 0 |
| Symbol versions | 29,791 |
| Structural relations | 34,818 |
| Snapshot status | `complete` |
| Wall clock | 5m 55s |

That is roughly **7.4 files per second end to end**, including symbol
extraction, relation resolution, dispatch resolution, lineage, effect
signatures, contract mining, and concept families. Ingest cost grows with
database size — the LSH change in 2.6.0 exists because the previous schema
slowed down as the index accumulated. Reproduce on your own corpus with
`npx ts-node scripts/bench-ingest.ts`.

The token-reduction tables below are older, from the versions named in each
heading. They were not re-run for 2.6.0.

---

## Historical Headline Results

| Benchmark | Scale | Exact-symbol reduction | Exact-symbol savings | Whole-source reduction |
|---|---|---:|---:|---:|
| Engine self-ingest (8 tasks) | 105 files, 7,753 symbols | **2.71x** | **63.1%** | — |
| VS Code (12 tasks) | 10,386 files, 125,777 symbol versions | **12.44x** | **91.96%** | 1,618x |
| Multi-language, 7 repos (21 tasks) | Django, Prometheus, Tokio, Commons Lang, Serilog, OkHttp, Alamofire | **12.86x** | **92.2%** | 134x (99.26%) |

Savings scale with repository size: the bigger the codebase, the more a
targeted capsule beats reading files. On small repositories or
single-file symbols the gain is modest, and in a few cases (noted below)
a capsule can be larger than the single file it replaces.

---

## Benchmark 1 — Engine Self-Ingest

ContextZero ingesting and analyzing its own repository.

| Metric | Value |
|---|---|
| Source/document files | 139 (72,284 lines, ~3.0 MB) |
| Files indexed | 105 |
| Symbols extracted | 7,753 |
| Symbol versions indexed | 5,017 |
| Relations extracted | 4,568 |
| Behavior hints | 1,288 |
| Contract hints | 716 |
| Deep contracts mined | 6,841 |
| Effect signatures | 5,017 |
| Invariants indexed | 7,889 |
| Dispatch edges | 573 resolved / 466 indexed |
| Concept families | 9 |
| Ingestion wall time | ~47 s |

### Token savings (8 real symbols, exact-symbol baseline)

| Symbol | Baseline tokens | ContextZero tokens | Reduction | Savings |
|---|---:|---:|---:|---:|
| DeepContractSynthesizer | 65,793 | 24,711 | 2.66x | 62.4% |
| Ingestor | 44,945 | 21,430 | 2.10x | 52.3% |
| DispatchResolver | 53,214 | 19,081 | 2.79x | 64.1% |
| RuntimeEvidenceEngine | 36,376 | 16,545 | 2.20x | 54.5% |
| ConceptFamilyEngine | 49,666 | 15,827 | 3.14x | 68.1% |
| EffectEngine | 52,151 | 14,154 | 3.68x | 72.9% |
| CapsuleCompiler | 17,758 | 13,298 | 1.34x | 25.1% |
| SemanticEngine | 53,543 | 12,907 | 4.15x | 75.9% |
| **Total** | **373,446** | **137,953** | **2.71x** | **63.1%** |

### Query latency (self-ingest snapshot)

| Query | Time | Output size |
|---|---:|---:|
| Health check | 3 ms | 123 B |
| Blast radius (depth 2) | 102 ms | 34 KB |
| Strict context capsule | 62 ms | 99 KB |

MCP compatibility: stdio bridge starts, lists all 61 tools, handshake +
`tools/list` in under 1 s.

---

## Benchmark 2 — VS Code (Large Repository)

Target: `https://github.com/microsoft/vscode.git` at commit
`eb840b14a01b070781ad36f6fa4fcc495e1543a6` — about 12,400 source/document
files and 4.1 M lines.

| Metric | Value |
|---|---|
| Source/document estimated tokens | 40,412,590 |
| Files indexed | 10,386 |
| Symbols extracted | 130,714 |
| Symbol versions indexed | 125,777 |
| Structural relations indexed | 230,853 |
| Deep contracts mined | 458,356 |
| Invariants indexed | 479,920 |
| Class hierarchy rows | 35,052 |
| Ingestion wall time | ~37 min (single process) |

### Token savings (12 real symbols)

| Totals | Whole-source | Exact-symbol | ContextZero |
|---|---:|---:|---:|
| Tokens | 484,951,080 | 3,726,330 | **299,569** |
| Reduction vs ContextZero | 1,618.83x | 12.44x | — |
| Savings | 99.94% | **91.96%** | — |

Representative tasks: `CommandCenter` in `extensions/git/src/commands.ts`
(5.67x, 82.4% savings), `completionSpec` in the terminal-suggest extension
(12.44x, 92.0%), and TextMate-grammar data symbols spread across dozens of
files (32–41x where the symbol name appears in many places).

Capsule queries against the 125k-symbol snapshot stayed fast: blast radius
in 164 ms, strict capsule in 49 ms.

---

## Benchmark 3 — Multi-Language (7 Repositories)

End-to-end ingest of cloned public repositories, then 3 real symbol tasks
per repository against the exact-symbol baseline.

| Repo | Language | Files indexed | Symbol versions | Relations | Exact reduction | Exact savings |
|---|---|---:|---:|---:|---:|---:|
| Django | Python | 2,955 | 42,500 | 35,342 | 7.99x | 87.5% |
| Prometheus | Go (+TS UI) | 967 | 12,360 | 25,163 | 27.97x | 96.4% |
| Tokio | Rust | 775 | 9,150 | 7,184 | 27.09x | 96.3% |
| Apache Commons Lang | Java | 606 | 11,628 | 7,210 | 22.57x | 95.6% |
| Serilog | C# | 215 | 1,360 | 355 | 4.74x | 78.9% |
| OkHttp | Kotlin/Java | 644 | 1,272 | 472 | 1.43x | 29.9% |
| Alamofire | Swift | 108 | 1,968 | 3,888 | 1.25x | 20.0% |

**Aggregate across all 21 tasks**: 5,088,582 baseline tokens vs 395,687
ContextZero tokens — **12.86x fewer tokens (92.2% savings)**, and **99.26%
savings (134x)** against whole-source loading.

### Adapter validation

Every advertised language path passes a symbol/relation extraction check:
TypeScript and JavaScript (TypeScript Compiler API), Python (LibCST
subprocess), and C/C++, Go, Rust, Java, C#, Ruby, Kotlin, Swift, PHP, and
Bash (tree-sitter universal adapter).

### Honest caveats from this run

- **Small, self-contained targets gain little.** The OkHttp and Alamofire
  tasks targeted large test classes that live in one or two files; a strict
  capsule has a size floor, so savings were small — and for one
  single-file Prometheus symbol (`getRawProtobufCorpus`) the capsule was
  actually *larger* than the file (0.6x). ContextZero pays off on symbols
  whose context is spread across a codebase, which is the common case in
  real maintenance work.
- **Laravel and nvm** ingested without errors but produced no scoreable
  symbol targets in the recorded run, so no token-savings claims are made
  for PHP and Bash at repository scale (adapter validation passes for
  both).
- **Spring Framework, Rails, and Bitcoin Core** runs were stopped before
  completion (one timed out after about an hour; two were interrupted), so
  no numbers are claimed for them. Java, Ruby, and C++ adapter validation
  passes.

---

## Analysis Quality Snapshot

From an instrumented full-analysis run on the engine's own codebase:

| Aspect | Result |
|---|---|
| Behavioral purity distribution | 95.2% `pure`, 3.2% `read_only`, 1.3% `read_write`, 0.3% `side_effecting` — every symbol profiled |
| Capsule budget utilization | `standard` mode: 99.96% of an 8,000-token budget; `strict`: 99%+ of 20,000 |
| Profile cache hit rate | 97.1% under analytical workloads |
| Semantic search scores | Calibrated TF-IDF cosine scores (e.g. 0.586 for "database transaction with rollback") — no inflated confidence |
| Parse errors | 0 |

---

## Fixture-Suite Effect-Analysis Accuracy (v2.5.0)

v2.5.0 replaced pattern-guessed external effects with a type-resolved
analyzer for TypeScript/JavaScript (every call resolved through the
compiler back to its source module). Accuracy is measured against a
hand-labeled fixture suite shipped in the repository — 22 functions across
8 external-effect categories, including the known failure traps of the old
analyzer (`Map.get`, `crypto.update`, effect words in comments and string
literals, calls on untyped local receivers, `WebSocket` as a type
annotation).

| Analyzer | Precision | Recall | F1 |
|---|---:|---:|---:|
| **v2.5 type-resolved** | **100%** | **100%** | **100%** |
| v2.3/v2.4 pattern-based (same suite) | 50.0% | 68.8% | 57.9% |

Honest framing:

- These are **fixture-suite numbers, not a field study**. The suite was
  designed alongside the analyzer; it includes the traps that made the old
  system lie, but the wild contains receiver shapes the suite doesn't.
- **Known recall limit by design**: calls on receivers the checker cannot
  trace to a module (`any`-typed parameters, dependency-injected clients
  without type annotations) produce **no** external-effect tag rather than
  a guess. Transitive propagation usually recovers these when the injected
  implementation lives in the same repository.
- Per-symbol behavioral profiles are now strictly **direct** (what the
  function's own body does); transitive effects are provenance-labeled
  (`direct` vs `transitive`, with hop counts) in effect signatures instead
  of being silently merged in.
- Reproduce: `npx ts-node scripts/effect-eval.ts` (add `--json` for
  machine-readable output). A CI test (`effect-resolver.test.ts`) pins the
  fixture suite so the table above cannot silently rot.

---

## Real-Project Benchmark Refresh (v2.5.0, 2026-07-10)

Author-reported token savings with the v2.5.0 engine on four real, private,
actively developed repositories (same methodology as above: `ceil(bytes/4)`
token policy, 8 real symbols per repository, exact-symbol grep-and-read
baseline vs one strict context capsule per symbol). Run on a freshly
compacted local PostgreSQL 16; the repositories are ClassEve production
codebases, not toy corpora.

Because those repositories and raw run outputs are private and absent from
this repository, these four rows cannot be independently reproduced from the
public checkout. They must not be used as release-gate evidence.

| Repository | Files indexed | Symbols | Exact-symbol baseline (tokens) | ContextZero (tokens) | Reduction | Savings |
|---|---:|---:|---:|---:|---:|---:|
| Engine self-ingest | 122 | 1,785 | 333,000 | 123,323 | **2.7x** | **63.0%** |
| Next.js website (~80 routes) | 141 | 492 | 239,868 | 64,804 | **3.7x** | **73.0%** |
| Cloudflare worker API | 46 | 384 | 4,127,654 | 111,289 | **37.1x** | **97.3%** |
| Desktop-app monorepo | 2,411 | 27,095 | 15,534,914 | 211,613 | **73.4x** | **98.6%** |

Consistent with the earlier runs: savings scale with repository size and
file granularity. The worker's outsized ratio comes from its shape — a few
very large route/webhook files, so the grep-and-read baseline pays for
entire multi-thousand-line files where a capsule pays for one symbol
neighborhood. Whole-source baselines for the same runs: 45.0x / 63.0x /
51.1x / 725.5x.

---

## Reproducing

All benchmark scripts are in the repository and run with `ts-node` against
your configured database (`DB_*` environment variables):

```bash
# Cost AND quality in one run: the numbers in the headline above
node scripts/bench-context-quality.mjs 400 /path/to/indexed/repo

# Full single-repo benchmark report (corpus, ingest, queries, token savings)
npx ts-node scripts/bench-report.ts /path/to/repo ./BENCHMARK_REPORT.md

# Head-to-head: grep+read vs capsule for N random symbols
npx ts-node scripts/bench-head-to-head.ts

# Ingest-only timing
npx ts-node scripts/bench-ingest.ts

# Per-mode capsule compilation measurements
npx ts-node scripts/bench-capsule.ts

# Multi-language suite (expects cloned repos under ./benchmarks)
npx ts-node scripts/multi-language-bench-report.ts ./benchmarks
```

Numbers on your machine may differ in both absolute terms and reduction ratios.
The token-counting policy is deterministic, but corpus versions, selected
symbols, ingestion results, and engine changes all affect the comparison.

If a reduction ratio comes back far larger than the ones in the headline, check
the baseline pool before believing it. `bench-context-quality.mjs` restricts both
sides to the files the index covers for exactly this reason; the older scripts
grep the directory as they find it, and a repository with worktrees, vendored
copies or a second checkout inside it will hand the baseline the same file
several times over.
