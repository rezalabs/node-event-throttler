const BaseStrategy = require('./BaseStrategy')

const DEFAULT_BUCKET_SIZE = 10
const DEFAULT_REFILL_RATE = 1 // tokens per second
const MS_PER_SECOND = 1000
const MIN_RETRY_DELAY_MS = 1

/**
 * A token bucket strategy that allows bursts and refills at a constant rate.
 * @implements {BaseStrategy}
 */
class TokenBucketStrategy extends BaseStrategy {
    static strategyType = 'token-bucket'

    /**
     * @param {object} [options={}]
     * @param {number} [options.bucketSize=10] - The maximum number of tokens.
     * @param {number} [options.refillRate=1] - The number of tokens to add per second.
     */
    constructor (options = {}) {
        super()
        this.bucketSize = options.bucketSize ?? DEFAULT_BUCKET_SIZE
        this.refillRate = options.refillRate ?? DEFAULT_REFILL_RATE
    }

    /**
   * @override
   */
    async track (record, eventData) {
        const now = Date.now()
        let updatedRecord = record

        if (!updatedRecord) {
            const config = {
                bucketSize: this.bucketSize,
                refillRate: this.refillRate,
                deferInterval: this.tracker.config.deferInterval
            }
            updatedRecord = {
                ...this._createBaseRecord(eventData, now, this.tracker.config.expireTime),
                config,
                strategyData: {
                    tokens: config.bucketSize - 1, // Consume one token immediately
                    lastRefill: now
                }
            }
            return { outcome: 'immediate', record: updatedRecord }
        }

        // --- Refill logic ---
        const { tokens, lastRefill } = updatedRecord.strategyData
        const config = updatedRecord.config
        const elapsedMs = now - lastRefill
        // Refill tokens precisely, carrying over fractional parts by not flooring.
        const tokensToAdd = (elapsedMs / MS_PER_SECOND) * config.refillRate
        const currentTokens = Math.min(config.bucketSize, tokens + tokensToAdd)
        updatedRecord.strategyData.lastRefill = now

        // --- Consumption logic ---
        if (currentTokens >= 1) {
            updatedRecord.strategyData.tokens = currentTokens - 1
            updatedRecord.count += 1
            updatedRecord.lastEventTime = now
            updatedRecord.expiresAt = now + this.tracker.config.expireTime
            // A successful event clears any previous deferred status
            updatedRecord.deferred = false
            updatedRecord.scheduledSendAt = null
            return { outcome: 'immediate', record: updatedRecord }
        } else {
            // Not enough tokens, defer the event.
            updatedRecord.strategyData.tokens = currentTokens
            updatedRecord.deferred = true
            updatedRecord.lastEventTime = now
            // Extend expiry so an actively rate-limited stream keeps its record alive.
            updatedRecord.expiresAt = now + this.tracker.config.expireTime
            // Schedule retry when we expect the next token to be available.
            const timeToNextTokenMs = (1 - currentTokens) * (MS_PER_SECOND / config.refillRate)
            updatedRecord.scheduledSendAt = now + Math.max(timeToNextTokenMs, MIN_RETRY_DELAY_MS)
            return { outcome: 'deferred', record: updatedRecord }
        }
    }
}

module.exports = TokenBucketStrategy
