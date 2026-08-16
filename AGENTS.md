# AGENTS.md

Operational guide for `@askrjs/server`, which owns transport-neutral routing,
middleware, binding, responses, probes, and OpenAPI contracts.

## Askr North Star

Keep request handling narratable from route match through ordered middleware
and binding to one explicit `Response`. Enforce invalid routes, middleware,
bindings, and response contracts at their owning boundary with corrective
errors. Test thrown, rejected, aborted, streaming, and cleanup paths for every
new primitive. Preserve the seam between the Web `Request`/`Response` core and
runtime adapters. Prefer explicit route tables and middleware order over
discovery or auto-wiring. Add server surface only for demonstrated application
needs.

Run `npm run check` and the affected benchmark tier before declaring a
performance-sensitive change ready.

## Optimization Gate

A benchmark number is only half of an optimization's success criterion. The
change must also preserve a causal path that a human or agent can narrate in one
sentence.

Every benchmark-driven change must include:

1. the one-sentence causal description of the optimized path;
2. the exact fallback trigger and proof that optimized and fallback paths have
   identical observable behavior and error surfaces;
3. an explicit legibility-cost statement, including `none` when no new path or
   concept is introduced; and
4. evidence that a measured bottleneck in a real application justifies the
   optimization now.

Prefer making the existing single path faster. New caches, inference,
memoization, shortcuts, fast paths, or scheduler states require an explicit
legibility decision; a speedup alone does not justify them.
