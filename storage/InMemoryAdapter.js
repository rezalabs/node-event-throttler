const BaseAdapter = require('./BaseAdapter')

const DEFAULT_PURGE_INTERVAL_MS = 60 * 1000 // 1 minute

/**
 * An in-memory storage adapter, suitable for single-process applications.
 * @implements {BaseAdapter}
 */
class InMemoryAdapter extends BaseAdapter {
    /**
     * @param {object} [options] - Configuration options.
     * @param {number} [options.purgeInterval] - How often (ms) to remove expired records.
     */
    constructor (options = {}) {
        super()
        this.events = new Map()
        // Optimization: Secondary index to track only deferred keys.
        // This allows O(1) or O(m) access to deferred events instead of scanning the entire map O(n).
        this.deferredKeys = new Set()
        this.isDestroyed = false
        // Async mutex implementation: Map of key -> { queue: Promise[], locked: boolean }
        this._locks = new Map()
        // Per-instance flag so warnings are deduplicated per adapter, not globally.
        this._warnedCloneFallback = false
        const purgeInterval = options.purgeInterval ?? DEFAULT_PURGE_INTERVAL_MS

        if (purgeInterval > 0) {
            this._startPurgeLoop(purgeInterval)
        }
    }

    _startPurgeLoop (interval) {
        const loop = () => {
            if (this.isDestroyed) return
            this.purgeExpired()
            this.purgeTimeoutId = setTimeout(loop, interval)
        }
        this.purgeTimeoutId = setTimeout(loop, interval)
    }

    purgeExpired () {
        const now = Date.now()
        for (const [key, record] of this.events.entries()) {
            if (now > record.expiresAt) {
                this.events.delete(key)
                this.deferredKeys.delete(key)
            }
        }
    }

    /**
     * Acquires an async mutex lock for the given key.
     * @private
     * @param {string} key - The key to lock.
     * @returns {Promise<Function>} A release function to unlock.
     */
    async _acquireLock (key) {
        if (!this._locks.has(key)) {
            this._locks.set(key, { locked: false, queue: [] })
        }

        const lock = this._locks.get(key)

        return new Promise((resolve) => {
            const tryAcquire = () => {
                if (!lock.locked) {
                    lock.locked = true
                    resolve(() => {
                        lock.locked = false
                        if (lock.queue.length > 0) {
                            const next = lock.queue.shift()
                            next()
                        } else {
                            // Clean up the lock entry when no longer needed
                            this._locks.delete(key)
                        }
                    })
                } else {
                    lock.queue.push(tryAcquire)
                }
            }
            tryAcquire()
        })
    }

    /**
     * Robust deep clone mechanism.
     * Uses structuredClone (Node 17+) if available, falling back to a recursive implementation.
     * @private
     * @param {*} obj - The object to clone.
     * @returns {*} The cloned object.
     */
    _deepClone (obj) {
        if (obj === null || typeof obj !== 'object') return obj

        // Priority 1: High-performance native cloning
        if (typeof structuredClone === 'function') {
            try {
                return structuredClone(obj)
            } catch (err) {
                // We fall through to the manual clone if the object contains
                // non-serializable items (functions, symbols, etc.)
                if (!this._warnedCloneFallback) {
                    this._emitWarning(
                        'structuredClone failed. Falling back to manual recursive clone. ' +
                        'This may impact throughput. Reason: ' + err.message
                    )
                    this._warnedCloneFallback = true
                }
            }
        }

        // Priority 2: Robust manual fallback
        // Handle specialized types that structuredClone might have failed on or in older Node versions
        if (obj instanceof Date) return new Date(obj.getTime())
        if (obj instanceof RegExp) return new RegExp(obj)
        if (Array.isArray(obj)) return obj.map(item => this._deepClone(item))
        if (obj instanceof Map) return new Map(Array.from(obj, ([k, v]) => [this._deepClone(k), this._deepClone(v)]))
        if (obj instanceof Set) return new Set(Array.from(obj, v => this._deepClone(v)))

        // General Object cloning
        const clone = Object.create(Object.getPrototypeOf(obj))
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                clone[key] = this._deepClone(obj[key])
            }
        }
        return clone
    }

    /**
     * Emits a process-level warning. InMemoryAdapter is not an EventEmitter,
     * so warnings are surfaced via process.emitWarning for library consumers.
     * @private
     * @param {string} message - The warning message.
     */
    _emitWarning (message) {
        if (typeof process !== 'undefined' && process.emitWarning) {
            process.emitWarning(message, 'InMemoryAdapterWarning')
        }
    }

    async get (key) {
        const record = this.events.get(key)
        return record ? this._deepClone(record) : undefined
    }

    async set (key, record) {
        this.events.set(key, this._deepClone(record))
        if (record.deferred) {
            this.deferredKeys.add(key)
        } else {
            this.deferredKeys.delete(key)
        }
    }

    async delete (key) {
        this.events.delete(key)
        this.deferredKeys.delete(key)
    }

    async update (key, updateFn) {
        const record = this.events.get(key)
        if (!record) return false

        // Pass a clone to the update function to protect internal state
        const clonedRecord = this._deepClone(record)
        const updatedRecord = updateFn(clonedRecord)

        // Store a clone of the result
        this.events.set(key, this._deepClone(updatedRecord))

        // Maintain secondary index
        if (updatedRecord.deferred) {
            this.deferredKeys.add(key)
        } else {
            this.deferredKeys.delete(key)
        }
        return true
    }

    async size () {
        return this.events.size
    }

    /**
     * Atomically tracks an event using the provided strategy.
     * @param {string} key - The composite key.
     * @param {object} eventData - Data about the event (category, id, details, detailsHash).
     * @param {object} trackerConfig - The tracker's global configuration.
     * @param {import('../strategies/BaseStrategy')} strategy - The strategy instance.
     * @returns {Promise<{outcome: 'immediate'|'deferred'|'ignored', record: object|null, reason?: string}>}
     */
    async track (key, eventData, trackerConfig, strategy) {
        // Acquire async mutex lock for this key to ensure atomicity
        const release = await this._acquireLock(key)

        try {
            const now = Date.now()
            let record = this.events.get(key)

            // Force reset if expired or details changed
            if (record) {
                const isExpired = now > record.expiresAt
                const detailsChanged = record.detailsHash !== eventData.detailsHash
                if (isExpired || detailsChanged) {
                    record = undefined
                }
            }

            if (!record && trackerConfig.maxKeys > 0) {
                if (this.events.size >= trackerConfig.maxKeys && !this.events.has(key)) {
                    return { outcome: 'ignored', reason: 'key_limit_reached', record: null }
                }
            }

            // Use the strategy to compute the next state
            const { outcome, record: updatedRecord } = await strategy.track(record ? this._deepClone(record) : undefined, {
                ...eventData,
                compositeKey: key
            })

            // Save back to memory
            this.events.set(key, this._deepClone(updatedRecord))
            if (updatedRecord.deferred) {
                this.deferredKeys.add(key)
            } else {
                this.deferredKeys.delete(key)
            }

            return { outcome, record: updatedRecord }
        } finally {
            release()
        }
    }

    async acquireKeySlot (key, maxKeys) {
        if (this.events.has(key)) return true
        if (this.events.size >= maxKeys) return false
        return true // The actual set will happen in the main tracker logic
    }

    async findDueDeferred (timestamp) {
        const due = []
        // Optimization: Only iterate known deferred keys
        for (const key of this.deferredKeys) {
            const record = this.events.get(key)
            // Defensive check: record might be missing if map/set out of sync (shouldn't happen)
            if (record && record.deferred && record.scheduledSendAt && timestamp >= record.scheduledSendAt) {
                due.push(this._deepClone(record))
            }
        }
        return due
    }

    async popDueDeferred (timestamp) {
        const dueEvents = []
        const keysToDelete = []

        // Optimization: Only iterate known deferred keys
        for (const key of this.deferredKeys) {
            const record = this.events.get(key)
            if (record && record.deferred && record.scheduledSendAt && timestamp >= record.scheduledSendAt) {
                dueEvents.push(this._deepClone(record))
                keysToDelete.push(key)
            }
        }

        for (const key of keysToDelete) {
            this.events.delete(key)
            this.deferredKeys.delete(key)
        }
        return dueEvents
    }

    async findAllDeferred () {
        const deferred = []
        for (const key of this.deferredKeys) {
            const record = this.events.get(key)
            if (record) {
                deferred.push(this._deepClone(record))
            }
        }
        return deferred
    }

    destroy () {
        this.isDestroyed = true
        if (this.purgeTimeoutId) {
            clearTimeout(this.purgeTimeoutId)
        }
        this.events.clear()
        this.deferredKeys.clear()
    }
}

module.exports = InMemoryAdapter
