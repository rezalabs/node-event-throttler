# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.6] - 2026-02-22

### Fixed
- Fixed `examples/redis-usage.js` shutdown order: `tracker.destroy()` now runs before `redisClient.quit()`, preventing the background processing loop from firing against a closed Redis connection.
- Fixed `__tests__/setup/globalSetup.js` crashing under Jest v30 when Redis is unavailable. The Redis client now has an `'error'` listener attached before `connect()` is called, suppressing the unhandled event that previously caused a fatal process exit.
- Fixed flaky assertion in `TokenBucketStrategy` test that used `toBe(3)` for a floating-point token count subject to sub-millisecond time-based refill. Changed to `toBeCloseTo(3)`.
- Fixed two 4-space indentation violations in `RedisAdapter.js` (lines 488–489, nested ternary branches) now surfaced by ESLint v9's stricter rule evaluation.

### Changed
- Upgraded ESLint from v8 to v9 with flat config (`eslint.config.mjs`). Replaced `eslint-config-standard`, `eslint-plugin-import`, `eslint-plugin-n`, and `eslint-plugin-promise` with `neostandard ^0.12.0`. Deleted legacy `.eslintrc.json`.
- Upgraded Jest from v29 to v30.
- Added `"overrides": { "minimatch": "^10.2.1" }` in `package.json` to force the patched minimatch version across the entire dependency tree, resolving all 29 high-severity ReDoS audit findings (CVE: GHSA-3ppc-4f35-3m26) in devDependencies.
- Added `globals ^16.0.0` as a direct devDependency for ESLint v9 environment configuration.
- Raised minimum Node.js engine requirement from `>=16.0.0` to `>=18.0.0` (ESLint v9 and Jest v30 both require Node.js 18+).
- Updated CI matrix to drop Node.js 16 and add Node.js 24.

## [1.0.5] - 2026-02-22

### Changed
- Moved `_warnedCloneFallback` flag from module-level to instance-level in `InMemoryAdapter`, eliminating shared mutable state across adapter instances.
- Removed the unreachable EventEmitter branch in `InMemoryAdapter._emitWarning`. The adapter does not extend `EventEmitter`, so `this.listenerCount` was always `undefined`; warnings now route directly to `process.emitWarning`.
- Simplified the redundant `else if (!lock.locked && lock.queue.length === 0)` guard in `InMemoryAdapter._acquireLock` to a plain `else` — both conditions are guaranteed by the surrounding control flow.
- Extracted `INITIAL_EVENT_COUNT` into `BaseStrategy` as a static property, removing the duplicate `const INITIAL_EVENT_COUNT = 1` declaration that existed independently in each of the three strategy files.
- Extracted shared base record construction into `BaseStrategy._createBaseRecord()`. All three strategies now call this helper for new-record initialization rather than duplicating the same ten-field object literal.
- Replaced the hardcoded `3` in `RedisAdapter.update()` with a module-level `UPDATE_MAX_RETRIES` constant.

## [1.0.4] - 2026-02-18

### Fixed
- Fixed `SimpleCounterStrategy` incorrectly incrementing `count` and updating `lastEventTime` on already-deferred records before returning `'ignored'`. Only `expiresAt` is now extended for ignored events to keep the record alive during active rate-limited streams.
- Fixed the same count-inflation bug in the Redis Lua script for the `simple` strategy: `count` is no longer incremented when the record is already deferred.
- Fixed `TokenBucketStrategy` and `SlidingWindowStrategy` not updating `expiresAt` or `lastEventTime` in their deferred branches, which could cause an actively rate-limited record to expire before it was processed.
- Fixed `EventTracker` constructor memory leak: when the `strategy instanceof BaseStrategy` validation failed, the already-created `InMemoryAdapter` (with its running purge-loop timer) was never destroyed. Storage is now cleaned up before re-throwing.
- Fixed `RedisAdapter.track()` using `||` instead of `??` to resolve strategy parameters, causing `strategy.limit === 0` or `strategy.windowSize === 0` to silently fall through to the wrong property.
- Fixed inconsistent `'ignored'` event payload shape: strategy-based ignores emitted a raw `EventRecord` while `key_limit_reached` ignores emitted `{ reason, category, id, details }`. Both now emit the same `{ reason, category, id, details }` shape. Strategy-based ignores use `reason: 'already_deferred'`.
- Fixed misleading assertion in `SimpleCounterStrategy` test that used reference equality (`toBe`) to assert "the record should not be modified", a claim the test could not actually verify. The assertion now checks the count value directly.
- Fixed test suite timer leaks: multiple tests in `ChaosEngineering.test.js` and `HighFidelityAudit.test.js` created `EventTracker` or `InMemoryAdapter` instances without calling `destroy()`, leaving purge-loop timers alive and causing Jest to force-exit workers. All instances are now properly torn down.

### Changed
- `trackEvent()` return value for strategy-based `'ignored'` outcomes now includes a `reason: 'already_deferred'` field (previously the field was absent). This is a backward-compatible addition.

## [1.0.3] - 2026-01-30

### Fixed
- **CRITICAL**: Fixed race condition in `InMemoryAdapter` lock mechanism by implementing proper async mutex with queue-based locking.
- **CRITICAL**: Fixed `RedisAdapter.update()` atomicity issue by properly using `WATCH` with `hGetAll` inside the watched scope.
- **CRITICAL**: Implemented missing `findDueDeferred()` method in `RedisAdapter` for manual processing mode.
- Fixed memory leak in lock map by automatically cleaning up lock entries when no longer needed.
- Fixed strategy type detection to use `strategyType` static property instead of `constructor.name` (safe for minification).
- Fixed console warnings in `InMemoryAdapter` by using `process.emitWarning()` instead of `console.warn`.
- Fixed inconsistent null handling in `RedisAdapter` deserialization with proper NaN checks.
- Standardized error messages in configuration validation.

### Added
- Added automatic retry logic with exponential backoff for failed processor callbacks (`maxRetries`, `retryDelay` options).
- Added `retry` event emission when processor retries are attempted.
- Added `attempts` property to `process_failed` event payload.
- Added `strategyType` static property to all strategy classes for safe type identification.
- Added `getStrategyType()` method to `BaseStrategy` class.
- Added strategy instance validation in `EventTracker` constructor (must extend `BaseStrategy`).

### Changed
- Improved `processDeferredEvents()` to iterate over events safely instead of using `forEach`.
- Removed redundant config spread in `trackEvent()`.
- Extracted magic numbers into named constants (`MIN_PROCESSING_INTERVAL_MS`, `DEFAULT_MAX_RETRIES`, `DEFAULT_RETRY_DELAY_MS`).
- Updated tests to accommodate retry logic behavior.

## [1.0.2] - 2026-01-23

### Fixed
- Fixed critical crash in `generateDetailsHash` when event details contain circular references.
- Fixed state corruption in `InMemoryAdapter` by implementing deep cloning (using `structuredClone` with a robust recursive fallback).
- Fixed bug in `SimpleCounterStrategy` where `expireTime` was not correctly applied or extended.
- Fixed bug in `InMemoryAdapter` where expired records were not correctly reset to count 1.
- Fixed Redis test suite flakiness by improving connection lifecycle and adding per-test state flushing.
- Fixed `RedisAdapter` potential crashes by implementing safe serialization helpers.

### Added
- Added `ChaosEngineering.test.js` to validate system robustness and edge cases.
- Added `HighFidelityAudit.test.js` to verify real-time drifting and expiration accuracy.
- Added per-key async lock mechanism in `InMemoryAdapter` to ensure atomic concurrent tracking.
- Added strict type validation for `category` and `id` in `trackEvent` (must be non-empty strings).

### Changed
- Clamped `processingInterval` to a minimum of 10ms for system stability.
- Improved JSDoc documentation across all storage adapters and strategies for better IDE support.
- Refined configuration validation to use `TypeError` and `RangeError` with descriptive messages.

## [1.0.1] - 2026-01-20

### Fixed
- Fixed security vulnerability in `js-yaml` dependency.
- Added connection state validation for `RedisAdapter`.
- Added JSON parsing error handling in `RedisAdapter`.
- Improved error context in Redis operations.
- Fixed indentation and linting issues.

### Added
- Added input validation for configuration values in `EventTracker`.
- Implemented batch retrieval for `findAllDeferred` in `RedisAdapter` using pipelining.
- Added constants for magic numbers in throttling strategies.
- Added ESLint with StandardJS configuration.
- Added community files: LICENSE, CONTRIBUTING.md, SECURITY.md, CODE_OF_CONDUCT.md.

### Changed
- Documented shallow copy behavior in `InMemoryAdapter`.

## [1.0.0] - 2026-01-15

### Added
- Initial release of Node Event Throttler.
- Support for `InMemoryAdapter` and `RedisAdapter`.
- Support for `SimpleCounterStrategy`, `TokenBucketStrategy`, and `SlidingWindowStrategy`.
