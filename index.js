const crypto = require('crypto')
const EventEmitter = require('events')
const InMemoryAdapter = require('./storage/InMemoryAdapter')
const RedisAdapter = require('./storage/RedisAdapter')
const BaseStrategy = require('./strategies/BaseStrategy')
const SimpleCounterStrategy = require('./strategies/SimpleCounterStrategy')
const TokenBucketStrategy = require('./strategies/TokenBucketStrategy')
const SlidingWindowStrategy = require('./strategies/SlidingWindowStrategy')

// Configuration defaults
const DEFAULT_LIMIT = 5
const DEFAULT_DEFER_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
const DEFAULT_EXPIRE_TIME_MS = 24 * 60 * 60 * 1000 // 24 hours
const DEFAULT_PROCESSING_INTERVAL_MS = 10000 // 10 seconds
const MIN_PROCESSING_INTERVAL_MS = 10
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 1000

/**
 * @typedef {import('./strategies/BaseStrategy').BaseStrategy} BaseStrategy
 * @typedef {import('./storage/BaseAdapter').BaseAdapter} BaseAdapter
 * @typedef {import('./storage/BaseAdapter').EventRecord} EventRecord
 */

/**
 * A robust, scalable event aggregation and throttling engine.
 */
class EventTracker extends EventEmitter {
    /**
     * @param {object} [options={}] - Configuration options.
     * @param {number} [options.limit=5] - Default max events (for SimpleCounterStrategy).
     * @param {number} [options.deferInterval] - Default time (ms) to wait before reprocessing.
     * @param {number} [options.expireTime] - Default time (ms) after which a record is stale.
     * @param {number} [options.maxKeys=0] - Max number of unique keys to track (0 for unlimited).
     * @param {BaseAdapter} [options.storage] - A storage adapter instance. Defaults to InMemoryAdapter.
     * @param {BaseStrategy} [options.strategy] - A throttling strategy instance. Defaults to SimpleCounterStrategy.
     * @param {function(EventRecord[]): Promise<void>} [options.processor] - Async callback for processing due events.
     * @param {number} [options.processingInterval=10000] - How often (ms) to check for due events. Minimum 10ms.
     * @param {number} [options.maxRetries=3] - Max retries for failed processor calls.
     * @param {number} [options.retryDelay=1000] - Delay (ms) between retries.
     */
    constructor (options = {}) {
        super()

        this._validateConfig(options)

        this.config = Object.freeze({
            limit: Math.max(0, options.limit ?? DEFAULT_LIMIT),
            deferInterval: Math.max(0, options.deferInterval ?? DEFAULT_DEFER_INTERVAL_MS),
            expireTime: Math.max(1, options.expireTime ?? DEFAULT_EXPIRE_TIME_MS),
            maxKeys: Math.max(0, options.maxKeys ?? 0)
        })

        this.storage = options.storage ?? new InMemoryAdapter()

        // Validate and set strategy
        const strategy = options.strategy ?? new SimpleCounterStrategy()
        if (!(strategy instanceof BaseStrategy)) {
            // Clean up the already-initialised storage (which may have started timers)
            // before throwing so callers are not left with a leaked purge loop.
            if (typeof this.storage.destroy === 'function') {
                this.storage.destroy()
            }
            throw new TypeError('strategy must be an instance of BaseStrategy.')
        }
        this.strategy = strategy

        // Inject this tracker instance into the strategy for its use.
        this.strategy.tracker = this

        this.processor = null
        this.processingIntervalMs = Math.max(MIN_PROCESSING_INTERVAL_MS, options.processingInterval ?? DEFAULT_PROCESSING_INTERVAL_MS)
        this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES)
        this.retryDelay = Math.max(0, options.retryDelay ?? DEFAULT_RETRY_DELAY_MS)
        this.processingTimeoutId = null
        this.isDestroyed = false

        if (typeof options.processor === 'function') {
            this.setProcessor(options.processor)
        }
    }

    /**
     * Validates configuration options.
     * @private
     * @param {object} options - Configuration options to validate.
     * @throws {TypeError} If an option has an invalid type.
     * @throws {RangeError} If an option has an invalid value range.
     */
    _validateConfig (options) {
        const numericFields = ['limit', 'deferInterval', 'expireTime', 'maxKeys', 'processingInterval', 'maxRetries', 'retryDelay']
        for (const field of numericFields) {
            if (options[field] !== undefined) {
                if (typeof options[field] !== 'number' || Number.isNaN(options[field])) {
                    throw new TypeError(`${field} must be a number.`)
                }
                if (options[field] < 0) {
                    throw new RangeError(`${field} must be non-negative.`)
                }
            }
        }
    }

    /**
     * Sets or replaces the processor callback and starts the processing loop.
     * @param {function(EventRecord[]): Promise<void>} processorFn - The async function to handle due events.
     */
    setProcessor (processorFn) {
        if (typeof processorFn !== 'function') {
            throw new Error('Processor must be a function.')
        }
        this.processor = processorFn
        if (this.processingTimeoutId) {
            clearTimeout(this.processingTimeoutId)
        }
        this._startProcessorLoop()
    }

    /**
     * Starts the background processing loop using a robust recursive setTimeout.
     * @private
     */
    _startProcessorLoop () {
        if (this.isDestroyed || !this.processor) return

        const loop = async () => {
            try {
                await this.processDeferredEvents()
            } catch (error) {
                // General loop errors (e.g. storage connectivity)
                this.emit('error', new Error(`Failed to process deferred events: ${error.message}`))
            } finally {
                if (!this.isDestroyed) {
                    this.processingTimeoutId = setTimeout(loop, this.processingIntervalMs)
                }
            }
        }

        // Start the first iteration without delay.
        this.processingTimeoutId = setTimeout(loop, this.processingIntervalMs)
    }

    /**
     * Generates a stable SHA256 hash of the event details object.
     * @param {object} details - The event details to hash.
     * @returns {string} The hex-encoded hash.
     */
    static generateDetailsHash (details) {
        if (!details || typeof details !== 'object' || Object.keys(details).length === 0) return ''
        try {
            // Stable serialization by sorting keys
            const sortedKeys = Object.keys(details).sort()
            const detailsString = JSON.stringify(details, sortedKeys)
            return crypto.createHash('sha256').update(detailsString).digest('hex')
        } catch (error) {
            // Handle circular references or other stringify errors gracefully
            return ''
        }
    }

    /**
     * Generates a unique SHA256 hash for a category and ID combination.
     * @param {string} category - The event category.
     * @param {string} id - The event identifier.
     * @returns {string} The hex-encoded composite key.
     * @throws {TypeError} if category or id are not strings.
     */
    static generateCompositeKey (category, id) {
        if (typeof category !== 'string' || typeof id !== 'string') {
            throw new TypeError('category and id must be strings.')
        }
        if (!category || !id) {
            throw new Error('category and id cannot be empty.')
        }
        const composite = `${category}:${id}`
        return crypto.createHash('sha256').update(composite).digest('hex')
    }

    /**
     * Tracks an event and applies the configured throttling strategy.
     * @param {string} category - High-level grouping of the event.
     * @param {string} id - Specific identifier within the category.
     * @param {object} [details={}] - The original event details object.
     * @returns {Promise<{type: 'immediate'|'deferred'|'ignored', data: EventRecord|null, reason?: string}>}
     */
    async trackEvent (category, id, details = {}) {
        const compositeKey = EventTracker.generateCompositeKey(category, id)
        const detailsHash = EventTracker.generateDetailsHash(details)
        const eventData = { category, id, details, detailsHash }

        const { outcome, record, reason } = await this.storage.track(
            compositeKey,
            eventData,
            this.config,
            this.strategy
        )

        if (outcome === 'ignored') {
            // Use a stable reason string regardless of the ignore source so that
            // 'ignored' event listeners always receive the same payload shape.
            const ignoreReason = reason ?? 'already_deferred'
            this.emit('ignored', { reason: ignoreReason, category, id, details })
            return { type: 'ignored', reason: ignoreReason, data: reason ? null : record }
        }

        this.emit(outcome, record)
        return { type: outcome, data: record }
    }

    /**
     * Finds due deferred events, processes them with the callback, and atomically removes them.
     * Includes retry logic with exponential backoff for failed processor calls.
     * @returns {Promise<EventRecord[]>} The list of events that were processed.
     */
    async processDeferredEvents () {
        if (!this.processor) {
            // Manual processing mode. Return due events without deleting.
            return this.storage.findDueDeferred(Date.now())
        }

        // Atomically pop due events from storage
        const dueEvents = await this.storage.popDueDeferred(Date.now())
        if (dueEvents.length === 0) {
            return dueEvents
        }

        let lastError = null
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                await this.processor(dueEvents)
                // Success - emit events individually
                for (const event of dueEvents) {
                    this.emit('processed', event)
                }
                return dueEvents
            } catch (error) {
                lastError = error
                if (attempt < this.maxRetries) {
                    // Exponential backoff: delay * 2^attempt
                    const delay = this.retryDelay * Math.pow(2, attempt)
                    this.emit('retry', { attempt: attempt + 1, maxRetries: this.maxRetries, delay, events: dueEvents })
                    await new Promise(resolve => setTimeout(resolve, delay))
                }
            }
        }

        // All retries exhausted - emit failure with context for DLQ handling
        this.emit('process_failed', {
            error: lastError,
            events: dueEvents,
            attempts: this.maxRetries + 1
        })
        this.emit('error', new Error(`Processor callback failed after ${this.maxRetries + 1} attempts: ${lastError.message}`))
        return dueEvents
    }

    /**
     * Updates the configuration for a specific event stream at runtime atomically.
     * @param {string} category
     * @param {string} id
     * @param {object} newConfig - The configuration fields to update.
     * @returns {Promise<boolean>} - True if the record was found and updated.
     */
    async updateConfig (category, id, newConfig) {
        if (!newConfig || typeof newConfig !== 'object') {
            throw new Error('newConfig must be an object.')
        }

        // Basic validation of known config fields if present
        if (newConfig.limit !== undefined && (typeof newConfig.limit !== 'number' || newConfig.limit < 0)) {
            throw new Error('limit must be a non-negative number.')
        }
        if (newConfig.deferInterval !== undefined && (typeof newConfig.deferInterval !== 'number' || newConfig.deferInterval < 0)) {
            throw new Error('deferInterval must be a non-negative number.')
        }

        const compositeKey = EventTracker.generateCompositeKey(category, id)
        const updated = await this.storage.update(compositeKey, (record) => {
            record.config = { ...record.config, ...newConfig }
            return record
        })

        if (updated) {
            const record = await this.storage.get(compositeKey)
            this.emit('config_updated', record)
        }
        return updated
    }

    /**
     * Retrieves all currently deferred events.
     * @returns {Promise<EventRecord[]>}
     */
    async getDeferredEvents () {
        return this.storage.findAllDeferred()
    }

    /**
     * Cleans up resources like timers and storage connections.
     */
    destroy () {
        this.isDestroyed = true
        if (this.processingTimeoutId) {
            clearTimeout(this.processingTimeoutId)
        }
        if (this.storage && typeof this.storage.destroy === 'function') {
            this.storage.destroy()
        }
        this.removeAllListeners()
    }
}

module.exports = EventTracker
module.exports.EventThrottler = EventTracker
module.exports.InMemoryAdapter = InMemoryAdapter
module.exports.RedisAdapter = RedisAdapter
module.exports.SimpleCounterStrategy = SimpleCounterStrategy
module.exports.TokenBucketStrategy = TokenBucketStrategy
module.exports.SlidingWindowStrategy = SlidingWindowStrategy
