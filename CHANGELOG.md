# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 0.5.0 - 2026-10-10

### Breaking

- Give every Server contract one canonical import path. Review all 214 baseline
  name/path pairs and retain 87 deliberate contracts. Root exports now cover the
  application and adapter contracts; routing, HTTP, middleware, auth, OpenAPI,
  MCP, Askr integration, and adapter testing use their dedicated entry points.
- Remove standalone status shortcuts, `defineRoutes`, public body readers,
  media parsing utilities, schema re-exports, and redundant supporting types.
  Use context status methods, `createRouter`, `ctx.bind`, direct Schema imports,
  and types derived from their supported owners. Rename context `bad` to
  `badRequest` and `serverError` to `internalServerError`.
- See [the complete API decisions and migration guide](docs/0.5.0-api.md).

### Fixed

- Enforce a stricter request-size limit on cached body reads. Abort stalled reads
  promptly, preserve their cause through model binding, and release reader locks
  without waiting for application cancellation hooks.
- Cancel suppressed HEAD bodies and downstream responses discarded by middleware,
  including responses that arrive after a middleware failure. Preserve transferred
  bodies and delivered clones.
- Retire middleware continuations after completion, including synchronous returns
  followed by queued microtasks.
- Reject invalid route, fallback, access-denial, and error-handler response values.
  Invalid access-denial values no longer fall through to the protected handler.
  Propagate a failing error handler once per request instead of invoking it again
  at enclosing middleware boundaries.
- Report invalid health-probe return values as unavailable.
- Make benchmark fixtures dispatch actual registered routes and check their types.

### Added

- Coverage floors for request dispatch/body ownership and the broader unit suite;
  normal packed-install runtime and strict declaration checks. See
  [0.5 hardening evidence](docs/0.5.0-hardening.md) for the exercised scenarios,
  observed costs, and qualification still pending.

### Development

- First-party development workflows use Vite+; specialized compiler, runtime,
  browser, and package checks remain part of validation.

## 0.4.1 - 2026-09-30

### Fixed

- Encode non-Latin-1 route metadata before placing it in the `x-askr-head`
  response header, preventing HTTP 500 responses for Unicode titles and
  descriptions.
- Percent-encode Unicode redirect locations while preserving existing percent
  escapes, so internationalized paths produce valid `Location` headers.
