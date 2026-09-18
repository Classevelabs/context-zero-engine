// Custom Jest test sequencer.
//
// The workspace symbol-search tests (workspace-parse-cache, workspace-native)
// parse with node-tree-sitter 0.22, which reclaims a Tree's native memory only
// on GC and exposes no delete(). When a heavy parser — the ingestor suite —
// shares a worker process and runs first, that lag exhausts the runtime and the
// next parse() returns a *rootless* tree for valid source, so the search finds
// nothing. The corruption persists for the worker's life, so retries do not
// recover it; running these files first puts them on a fresh worker before any
// such polluter can share the process, which is deterministic.
//
// This is a scheduling workaround for a tree-sitter 0.22 memory-management
// limitation; upgrading the runtime is the real fix and removes the need for it.
const Sequencer = require("@jest/test-sequencer").default

const RUN_FIRST = /workspace-parse-cache|workspace-native/

class FreshWorkerFirstSequencer extends Sequencer {
  async sort(tests) {
    const ordered = await Sequencer.prototype.sort.call(this, tests)
    const first = ordered.filter((t) => RUN_FIRST.test(t.path))
    const rest = ordered.filter((t) => !RUN_FIRST.test(t.path))
    return [...first, ...rest]
  }
}

module.exports = FreshWorkerFirstSequencer
