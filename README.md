# Node Event Throttler

A high-performance event aggregation and rate-limiting engine for Node.js.

Node Event Throttler provides a scalable solution for managing high-velocity event streams. Unlike standard rate limiters that drop traffic, this library aggregates events exceeding defined thresholds and schedules them for deferred batch processing. This architecture is engineered for system resilience, error alerting, and protecting downstream services from traffic spikes while ensuring data persistence.

## Core Objectives

*   **System Stability**: Protect downstream resources by enforcing configurable rate limits.
*   **Data Integrity**: Ensure zero event loss through atomic deferral and batch processing.
*   **Latency Mitigation**: Provide O(1) event tracking performance via optimized storage adapters.
*   **Scalability**: Support distributed state management across multiple Node.js instances using Redis.

## Technical Specifications

### Throttling Strategies

*   **Simple Counter**: Fixed-window counting for straightforward rate limiting.
*   **Token Bucket**: Supports burst traffic through a refillable token mechanism, maintaining a consistent long-term average.
*   **Sliding Window**: Provides precise rate limiting by calculating a weighted average across overlapping windows.

### Persistence Layers

*   **In-Memory Adapter**: Optimized for single-instance applications; utilizes secondary indexing for efficient retrieval of deferred records.
*   **Redis Adapter**: Designed for distributed environments; utilizes Lua scripts for atomic operations and cross-instance consistency.

## Installation

```bash
npm install node-event-throttler redis
```

## Implementation Guide

### Standard Configuration

```javascript
const EventTracker = require('node-event-throttler');

const tracker = new EventTracker({
  limit: 50,                // Maximum events per window
  deferInterval: 30000,     // Deferral duration in milliseconds
  expireTime: 3600000,      // Record TTL in milliseconds
  processor: async (events) => {
    // Implement batch processing logic (e.g., database persistence, API ingestion)
    await processBatch(events);
  }
});

async function trackRequest(userId, metadata) {
  const result = await tracker.trackEvent('api_request', userId, metadata);
  // Returns: { type: 'immediate' | 'deferred' | 'ignored', data: EventRecord }
}
```

### Distributed Configuration (Redis)

Integration with Redis requires the injection of custom Lua scripts to maintain atomicity.

```javascript
const { createClient } = require('redis');
const EventTracker = require('node-event-throttler');
const { RedisAdapter } = EventTracker;
const { scripts } = RedisAdapter;

async function initializeDistributedTracker() {
  const redisClient = createClient({
    url: 'redis://localhost:6379',
    scripts
  });
  
  await redisClient.connect();

  const tracker = new EventTracker({
    storage: new RedisAdapter({ redisClient }),
    limit: 100,
    deferInterval: 60000
  });
}
```

## Common Use Cases

### 1. Alerting De-duplication
Prevent notification storms by immediately alerting on the first few errors and batching subsequent identical errors.

```javascript
const tracker = new EventTracker({
  limit: 1,                 // Notify immediately on the first error
  deferInterval: 300000,    // Batch subsequent errors for 5 minutes
  processor: async (batch) => {
    await emailService.sendSummary(`Detected ${batch.length} additional occurrences of: ${batch[0].id}`);
  }
});

// Implementation in error handler
process.on('uncaughtException', (err) => {
  tracker.trackEvent('system_error', err.code, { stack: err.stack });
});
```

### 2. API Burst Management (Token Bucket)
Allow users to perform short bursts of actions while enforcing a strict long-term average rate.

```javascript
const { TokenBucketStrategy } = require('node-event-throttler');

const tracker = new EventTracker({
  strategy: new TokenBucketStrategy({
    bucketSize: 10,  // Allow burst of 10 requests
    refillRate: 0.5  // Refill 1 token every 2 seconds (0.5 tokens/sec)
  }),
  processor: async (deferred) => {
    // Logic for handling requests that exceeded burst capacity
  }
});
```

### 3. Log Aggregation
Reduce I/O overhead by batching high-frequency logs before persisting to a database or external log provider.

```javascript
const tracker = new EventTracker({
  limit: 100,              // Process logs immediately up to 100/min
  deferInterval: 10000,    // Batch excess logs every 10 seconds
  processor: async (logs) => {
    await elasticsearch.bulkIndex(logs.map(l => l.details));
  }
});
```

## Resilience and Error Handling

Node Event Throttler includes built-in retry logic with exponential backoff. When the configured `processor` fails, it will automatically retry up to `maxRetries` times (default: 3) with exponentially increasing delays.

```javascript
const tracker = new EventTracker({
  processor: async (events) => { /* ... */ },
  maxRetries: 3,     // Retry up to 3 times
  retryDelay: 1000   // Start with 1s delay, then 2s, then 4s
});

// Monitor retry attempts
tracker.on('retry', ({ attempt, maxRetries, delay, events }) => {
  console.log(`Retry ${attempt}/${maxRetries} in ${delay}ms for ${events.length} events`);
});

// Handle final failure after all retries exhausted
tracker.on('process_failed', ({ error, events, attempts }) => {
  // Persist to Dead Letter Queue for manual recovery
  console.error(`Failed after ${attempts} attempts:`, error);
  deadLetterQueue.push(events);
});
```

To disable retries and handle failures immediately, set `maxRetries: 0`.

## API Reference

### Constructor Parameters

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `limit` | number | 5 | Default event threshold. |
| `deferInterval` | number | 3600000 | ms to defer events once limit is reached. |
| `expireTime` | number | 86400000 | ms before a record is purged from storage. |
| `maxKeys` | number | 0 | Maximum unique identifiers (0 for unlimited). |
| `processor` | function | null | Async callback for handling deferred events. |
| `storage` | Adapter | InMemory | Instance of a storage adapter. |
| `strategy` | Strategy | SimpleCounter | Instance of a throttling strategy. |
| `maxRetries` | number | 3 | Maximum retry attempts for failed processor calls. |
| `retryDelay` | number | 1000 | Base delay (ms) between retries (exponential backoff). |

### Event Lifecycle

| Event | Payload | Context |
| :--- | :--- | :--- |
| `immediate` | `EventRecord` | Event processed within rate limits. |
| `deferred` | `EventRecord` | Event exceeds limit; scheduled for processing. |
| `ignored` | `object` | Event dropped due to system constraints (e.g., maxKeys). |
| `processed` | `EventRecord` | Successful execution of the processor callback. |
| `retry` | `object` | Processor retry attempt (`{ attempt, maxRetries, delay, events }`). |
| `process_failed` | `object` | All retry attempts exhausted (`{ error, events, attempts }`). |
| `config_updated` | `EventRecord` | Configuration updated via `updateConfig()`. |
| `error` | `Error` | General error (e.g., processor failure, storage error). |

## Development and Testing

The project maintains 100% test coverage using Jest.

```bash
npm test
```

## License

ISC