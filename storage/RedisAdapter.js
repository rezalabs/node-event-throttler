const { defineScript } = require('redis')
const BaseAdapter = require('./BaseAdapter')

const KEY_PREFIX = 'event-tracker:'
const DEFERRED_SET_KEY = `${KEY_PREFIX}deferred-set`
const SIZE_KEY = `${KEY_PREFIX}size`
const UPDATE_MAX_RETRIES = 3

// --- Script Definitions ---

const popDueDeferredScript = defineScript({
    NUMBER_OF_KEYS: 2,
    SCRIPT: `
    local deferredSetKey = KEYS[1]
    local sizeKey = KEYS[2]
    local keyPrefix = ARGV[1]
    local timestamp = ARGV[2]
    local dueKeys = redis.call('ZRANGEBYSCORE', deferredSetKey, 0, timestamp)
    if #dueKeys == 0 then
      return {}
    end
    redis.call('ZREM', deferredSetKey, unpack(dueKeys))
    local results = {}
    for _, key in ipairs(dueKeys) do
      local recordKey = keyPrefix .. key
      local recordData = redis.call('HGETALL', recordKey)
      redis.call('DEL', recordKey)
      redis.call('DECR', sizeKey)
      table.insert(results, {key, recordData})
    end
    return results
  `,
    transformArguments (keys, args) {
        return [...keys, ...args]
    }
})

const trackScript = defineScript({
    NUMBER_OF_KEYS: 3,
    SCRIPT: `
    local recordKey = KEYS[1]
    local sizeKey = KEYS[2]
    local deferredSetKey = KEYS[3]

    local key = ARGV[1]
    local category = ARGV[2]
    local id = ARGV[3]
    local details = ARGV[4]
    local detailsHash = ARGV[5]
    local now = tonumber(ARGV[6])
    local expireTime = tonumber(ARGV[7])
    local maxKeys = tonumber(ARGV[8])
    local strategyType = ARGV[9]
    local sParam1 = tonumber(ARGV[10])
    local sParam2 = tonumber(ARGV[11])
    local sParam3 = tonumber(ARGV[12])
    local initialConfig = ARGV[13]

    local record = redis.call('HGETALL', recordKey)
    local existing = {}
    if #record > 0 then
        for i = 1, #record, 2 do
            existing[record[i]] = record[i+1]
        end
    end

    local isNew = #record == 0
    local isExpired = not isNew and now > tonumber(existing.expiresAt or 0)
    local detailsChanged = not isNew and existing.detailsHash ~= detailsHash

    if isExpired or detailsChanged then
        isNew = true
    end

    if isNew then
        local currentSize = tonumber(redis.call('GET', sizeKey) or '0')
        if maxKeys > 0 and currentSize >= maxKeys and redis.call('EXISTS', recordKey) == 0 then
            return { 'ignored', 'key_limit_reached' }
        end
        if redis.call('EXISTS', recordKey) == 0 then
            redis.call('INCR', sizeKey)
        end
    end

    local outcome = 'immediate'
    local count = isNew and 0 or tonumber(existing.count or 0)
    local deferred = not isNew and existing.deferred == 'true'
    local scheduledSendAt = not isNew and tonumber(existing.scheduledSendAt or 0) or 0
    local strategyData = {}

    if strategyType == 'simple' then
        local limit = sParam1
        local deferInterval = sParam2
        if deferred then
            -- Already deferred: extend expiry (handled below) but do not inflate count.
            outcome = 'ignored'
        else
            count = count + 1
            if count > limit then
                outcome = 'deferred'
                deferred = true
                scheduledSendAt = now + deferInterval
            end
        end
    elseif strategyType == 'token-bucket' then
        local bucketSize = sParam1
        local refillRate = sParam2
        local deferInterval = sParam3
        local tokens = bucketSize
        local lastRefill = now
        
        if not isNew and existing.strategyData then
            local sd = cjson.decode(existing.strategyData)
            tokens = tonumber(sd.tokens)
            lastRefill = tonumber(sd.lastRefill)
            local elapsedMs = now - lastRefill
            tokens = math.min(bucketSize, tokens + (elapsedMs / 1000) * refillRate)
        end
        
        if tokens >= 1 then
            tokens = tokens - 1
            count = count + 1
            deferred = false
            scheduledSendAt = 0
        else
            outcome = 'deferred'
            deferred = true
            local timeToNextTokenMs = (1 - tokens) * (1000 / refillRate)
            scheduledSendAt = now + math.max(timeToNextTokenMs, 1)
        end
        strategyData.tokens = tokens
        strategyData.lastRefill = now
    elseif strategyType == 'sliding-window' then
        local limit = sParam1
        local windowSize = sParam2
        local deferInterval = sParam3
        local currentCount = 0
        local previousCount = 0
        local windowStart = now
        
        if not isNew and existing.strategyData then
            local sd = cjson.decode(existing.strategyData)
            currentCount = tonumber(sd.currentCount or 0)
            previousCount = tonumber(sd.previousCount or 0)
            windowStart = tonumber(sd.windowStart or now)
        end
        
        local elapsed = now - windowStart
        if elapsed >= windowSize then
            if elapsed >= windowSize * 2 then
                previousCount = 0
            else
                previousCount = currentCount
            end
            currentCount = 0
            windowStart = now - (elapsed % windowSize)
        end
        
        local weight = (windowSize - (now - windowStart)) / windowSize
        local estimatedCount = currentCount + (previousCount * weight)
        
        if estimatedCount < limit then
            currentCount = currentCount + 1
            count = math.floor(estimatedCount + 1)
            deferred = false
            scheduledSendAt = 0
        else
            outcome = 'deferred'
            deferred = true
            scheduledSendAt = now + deferInterval
        end
        strategyData.currentCount = currentCount
        strategyData.previousCount = previousCount
        strategyData.windowStart = windowStart
    end

    local expiresAt = now + expireTime
    local config = isNew and initialConfig or existing.config

    redis.call('HMSET', recordKey,
        'key', key,
        'category', category,
        'id', id,
        'details', details,
        'detailsHash', detailsHash,
        'count', tostring(count),
        'lastEventTime', tostring(now),
        'expiresAt', tostring(expiresAt),
        'deferred', tostring(deferred),
        'scheduledSendAt', tostring(scheduledSendAt),
        'strategyData', cjson.encode(strategyData),
        'config', config
    )
    redis.call('EXPIREAT', recordKey, math.ceil(expiresAt / 1000))

    if deferred then
        redis.call('ZADD', deferredSetKey, scheduledSendAt, key)
    else
        redis.call('ZREM', deferredSetKey, key)
    end

    return { outcome, tostring(count), tostring(scheduledSendAt), tostring(expiresAt), config, cjson.encode(strategyData) }
  `,
    transformArguments (keys, args) {
        return [...keys, ...args]
    }
})

const acquireKeySlotScript = defineScript({
    NUMBER_OF_KEYS: 2,
    SCRIPT: `
    local recordKey = KEYS[1]
    local sizeKey = KEYS[2]
    local maxKeys = ARGV[1]
    if redis.call('EXISTS', recordKey) == 1 then
      return 1
    end
    if tonumber(redis.call('GET', sizeKey) or '0') >= tonumber(maxKeys) then
      return 0
    end
    return 1
  `,
    transformArguments (keys, args) {
        return [...keys, ...args]
    }
})

/**
 * An adapter for storing event records in Redis for distributed systems.
 * @implements {BaseAdapter}
 */
class RedisAdapter extends BaseAdapter {
    /**
     * @param {object} options - Configuration options.
     * @param {import('redis').RedisClientType} options.redisClient - A connected and configured node-redis v4 client instance.
     */
    constructor (options) {
        super()
        if (!options || !options.redisClient) {
            throw new Error('A connected redis client instance must be provided.')
        }

        this.redis = options.redisClient

        // Verification: Ensure scripts are loaded.
        if (typeof this.redis.popDueDeferred !== 'function' ||
            typeof this.redis.acquireKeySlot !== 'function') {
            throw new Error(
                'Redis client is missing required scripts. ' +
                'Please import { scripts } from RedisAdapter and pass them to createClient({ scripts }).'
            )
        }
    }

    /**
     * @private
     * @throws {Error} if the redis client is not connected
     */
    _validateConnection () {
        // node-redis v4 uses .isOpen and .isReady
        if (!this.redis.isOpen) {
            throw new Error('Redis client is not connected.')
        }
    }

    _getRecordKey (key) {
        return `${KEY_PREFIX}${key}`
    }

    /**
     * @private
     */
    _safeParseJSON (json, defaultValue = {}) {
        if (!json) return defaultValue
        try {
            return JSON.parse(json)
        } catch (e) {
            // Log error or emit if possible, for now returning default to prevent crash
            return defaultValue
        }
    }

    /**
     * Deserializes raw Redis hash data into an EventRecord.
     * @private
     * @param {object} data - Raw data from Redis HGETALL.
     * @returns {EventRecord|undefined} Deserialized record, or undefined if invalid.
     */
    _deserialize (data) {
        if (!data || Object.keys(data).length === 0 || !data.key) return undefined
        try {
            // Parse scheduledSendAt consistently - null means not scheduled
            let scheduledSendAt = null
            if (data.scheduledSendAt && data.scheduledSendAt !== '0' && data.scheduledSendAt !== 'null') {
                const parsed = parseInt(data.scheduledSendAt, 10)
                scheduledSendAt = Number.isNaN(parsed) ? null : parsed
            }

            return {
                key: data.key,
                category: data.category ?? '',
                id: data.id ?? '',
                details: this._safeParseJSON(data.details, {}),
                detailsHash: data.detailsHash ?? '',
                count: parseInt(data.count ?? '0', 10) || 0,
                lastEventTime: parseInt(data.lastEventTime ?? '0', 10) || 0,
                expiresAt: parseInt(data.expiresAt ?? '0', 10) || 0,
                deferred: data.deferred === 'true',
                scheduledSendAt,
                config: this._safeParseJSON(data.config, {}),
                strategyData: data.strategyData ? this._safeParseJSON(data.strategyData, {}) : undefined
            }
        } catch (err) {
            // If data is corrupted, return undefined to avoid crashing the engine
            return undefined
        }
    }

    _serialize (record) {
        const flatRecord = {}
        for (const [key, value] of Object.entries(record)) {
            if (value === null || value === undefined) continue
            if (typeof value === 'object') {
                flatRecord[key] = this._safeStringify(value)
            } else {
                flatRecord[key] = value.toString()
            }
        }
        return flatRecord
    }

    async get (key) {
        this._validateConnection()
        const recordKey = this._getRecordKey(key)
        try {
            const data = await this.redis.hGetAll(recordKey)
            return this._deserialize(data)
        } catch (err) {
            throw new Error(`Redis GET failed for key ${key}: ${err.message}`)
        }
    }

    async set (key, record) {
        this._validateConnection()
        const recordKey = this._getRecordKey(key)
        const expiresAtSeconds = Math.ceil(record.expiresAt / 1000)

        try {
            const isNew = !(await this.redis.exists(recordKey))
            const transaction = this.redis.multi()

            if (isNew) {
                transaction.incr(SIZE_KEY)
            }

            transaction.hSet(recordKey, this._serialize(record))
            transaction.expireAt(recordKey, expiresAtSeconds)

            if (record.deferred && record.scheduledSendAt) {
                transaction.zAdd(DEFERRED_SET_KEY, { score: record.scheduledSendAt, value: record.key })
            } else {
                transaction.zRem(DEFERRED_SET_KEY, record.key)
            }
            await transaction.exec()
        } catch (err) {
            throw new Error(`Redis SET failed for key ${key}: ${err.message}`)
        }
    }

    async delete (key) {
        this._validateConnection()
        const recordKey = this._getRecordKey(key)
        try {
            const wasPresent = await this.redis.exists(recordKey)
            const transaction = this.redis.multi()

            if (wasPresent) {
                transaction.del(recordKey)
                transaction.decr(SIZE_KEY)
            }
            transaction.zRem(DEFERRED_SET_KEY, key)
            await transaction.exec()
        } catch (err) {
            throw new Error(`Redis DELETE failed for key ${key}: ${err.message}`)
        }
    }

    /**
     * Atomically updates a record using optimistic locking with WATCH.
     * @param {string} key - The key of the record to update.
     * @param {(record: EventRecord) => EventRecord} updateFn - A function that modifies the record.
     * @returns {Promise<boolean>} True if the record was found and updated.
     */
    async update (key, updateFn) {
        this._validateConnection()
        const recordKey = this._getRecordKey(key)

        // Retry loop for optimistic locking
        for (let attempt = 0; attempt < UPDATE_MAX_RETRIES; attempt++) {
            try {
                // Watch the key for changes during our operation
                await this.redis.watch(recordKey)

                // Fetch the record within the watch scope
                const data = await this.redis.hGetAll(recordKey)
                const record = this._deserialize(data)

                if (!record) {
                    await this.redis.unwatch()
                    return false
                }

                const updatedRecord = updateFn(record)
                const transaction = this.redis.multi()
                transaction.hSet(recordKey, this._serialize(updatedRecord))

                // Maintain the deferred set index if the status or schedule changed
                if (updatedRecord.deferred && updatedRecord.scheduledSendAt) {
                    transaction.zAdd(DEFERRED_SET_KEY, {
                        score: updatedRecord.scheduledSendAt,
                        value: updatedRecord.key
                    })
                } else {
                    transaction.zRem(DEFERRED_SET_KEY, key)
                }

                const results = await transaction.exec()

                // If exec returns null, the watched key was modified - retry
                if (results === null) {
                    continue
                }

                return true
            } catch (err) {
                // EXECABORT means the watch failed, retry
                if (err.message.includes('EXECABORT')) {
                    continue
                }
                throw new Error(`Redis UPDATE failed for key ${key}: ${err.message}`)
            }
        }

        // All retries exhausted
        return false
    }

    async size () {
        this._validateConnection()
        try {
            const sizeStr = await this.redis.get(SIZE_KEY)
            return parseInt(sizeStr ?? '0', 10)
        } catch (err) {
            throw new Error(`Redis SIZE failed: ${err.message}`)
        }
    }

    /**
     * @private
     */
    _safeStringify (obj, defaultValue = '{}') {
        if (!obj) return defaultValue
        try {
            return JSON.stringify(obj)
        } catch (e) {
            return defaultValue
        }
    }

    async track (key, eventData, trackerConfig, strategy) {
        this._validateConnection()
        const recordKey = this._getRecordKey(key)
        const now = Date.now()
        const { category, id, details, detailsHash } = eventData

        // Use the strategy's type identifier (safe for minification)
        const strategyType = strategy.getStrategyType ? strategy.getStrategyType() : 'simple'

        // Use ?? instead of || so that legitimate zero-values (e.g. limit:0, windowSize:0)
        // are passed correctly and do not fall through to the alternate property.
        const sParam1 = strategyType === 'simple' ? (trackerConfig.limit) : (strategy.limit ?? strategy.bucketSize)
        const sParam2 = strategyType === 'simple' ? (trackerConfig.deferInterval) : (strategy.windowSize ?? strategy.refillRate)
        const sParam3 = strategyType === 'simple' ? 0 : (trackerConfig.deferInterval)

        const initialConfig = strategyType === 'simple'
            ? { limit: trackerConfig.limit, deferInterval: trackerConfig.deferInterval }
            : (strategyType === 'token-bucket'
                ? { bucketSize: strategy.bucketSize, refillRate: strategy.refillRate, deferInterval: trackerConfig.deferInterval }
                : { limit: strategy.limit, windowSize: strategy.windowSize, deferInterval: trackerConfig.deferInterval })

        try {
            const result = await this.redis.track(
                [recordKey, SIZE_KEY, DEFERRED_SET_KEY],
                [
                    key,
                    category,
                    id,
                    this._safeStringify(details),
                    detailsHash,
                    now.toString(),
                    trackerConfig.expireTime.toString(),
                    trackerConfig.maxKeys.toString(),
                    strategyType,
                    sParam1.toString(),
                    sParam2.toString(),
                    sParam3.toString(),
                    this._safeStringify(initialConfig)
                ]
            )

            const [outcome, count, scheduledSendAtStr, expiresAtStr, config, strategyData] = result

            if (outcome === 'ignored' && count === 'key_limit_reached') {
                return { outcome: 'ignored', reason: 'key_limit_reached', record: null }
            }

            // Parse scheduledSendAt consistently - null means not scheduled
            let scheduledSendAt = null
            if (scheduledSendAtStr && scheduledSendAtStr !== '0' && scheduledSendAtStr !== 'null') {
                const parsed = parseInt(scheduledSendAtStr, 10)
                scheduledSendAt = Number.isNaN(parsed) ? null : parsed
            }

            const record = {
                key,
                category,
                id,
                details,
                detailsHash,
                count: parseInt(count, 10) || 0,
                lastEventTime: now,
                expiresAt: parseInt(expiresAtStr, 10) || 0,
                deferred: outcome === 'deferred',
                scheduledSendAt,
                config: this._safeParseJSON(config, {}),
                strategyData: this._safeParseJSON(strategyData, {})
            }

            return { outcome, record }
        } catch (err) {
            throw new Error(`Redis TRACK failed for key ${key}: ${err.message}`)
        }
    }

    async acquireKeySlot (key, maxKeys) {
        this._validateConnection()
        const recordKey = this._getRecordKey(key)
        try {
            const result = await this.redis.acquireKeySlot(
                [recordKey, SIZE_KEY],
                [maxKeys.toString()]
            )
            return result === 1
        } catch (err) {
            throw new Error(`Redis ACQUIRE_KEY_SLOT failed for key ${key}: ${err.message}`)
        }
    }

    /**
     * Finds all records that are deferred and due for processing (non-destructive).
     * @param {number} timestamp - The current timestamp to check against.
     * @returns {Promise<EventRecord[]>}
     */
    async findDueDeferred (timestamp) {
        this._validateConnection()
        try {
            // Get all deferred keys with scores <= timestamp (due for processing)
            const dueKeys = await this.redis.zRangeByScore(DEFERRED_SET_KEY, 0, timestamp)

            if (!dueKeys || dueKeys.length === 0) return []

            // Use a pipeline to fetch all records at once
            const pipeline = this.redis.multi()
            for (const key of dueKeys) {
                pipeline.hGetAll(this._getRecordKey(key))
            }
            const results = await pipeline.exec()

            return results
                .map(data => this._deserialize(data))
                .filter(Boolean)
        } catch (err) {
            throw new Error(`Redis FIND_DUE_DEFERRED failed: ${err.message}`)
        }
    }

    /**
     * Atomically finds, returns, and deletes all due deferred events.
     * @param {number} timestamp - The current timestamp to check against.
     * @returns {Promise<EventRecord[]>}
     */
    async popDueDeferred (timestamp) {
        this._validateConnection()
        try {
            const rawResults = await this.redis.popDueDeferred(
                [DEFERRED_SET_KEY, SIZE_KEY],
                [KEY_PREFIX, timestamp.toString()]
            )

            if (!rawResults || rawResults.length === 0) return []

            return rawResults.map(([, dataArray]) => {
                const dataObj = {}
                for (let i = 0; i < dataArray.length; i += 2) {
                    dataObj[dataArray[i]] = dataArray[i + 1]
                }
                return this._deserialize(dataObj)
            }).filter(Boolean)
        } catch (err) {
            throw new Error(`Redis POP_DUE_DEFERRED failed: ${err.message}`)
        }
    }

    async findAllDeferred () {
        this._validateConnection()
        try {
            const allDeferredKeys = await this.redis.zRange(DEFERRED_SET_KEY, 0, -1)
            if (!allDeferredKeys.length) return []

            // Use a pipeline to fetch all records at once
            const pipeline = this.redis.multi()
            for (const key of allDeferredKeys) {
                pipeline.hGetAll(this._getRecordKey(key))
            }
            const results = await pipeline.exec()

            return results
                .map(data => this._deserialize(data))
                .filter(Boolean)
        } catch (err) {
            throw new Error(`Redis FIND_ALL_DEFERRED failed: ${err.message}`)
        }
    }

    destroy () {}
}

module.exports = RedisAdapter
// Export script definitions for client configuration
module.exports.scripts = {
    popDueDeferred: popDueDeferredScript,
    acquireKeySlot: acquireKeySlotScript,
    track: trackScript
}
