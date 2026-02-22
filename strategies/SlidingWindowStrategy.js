const BaseStrategy = require('./BaseStrategy')

const DEFAULT_LIMIT = 10
const DEFAULT_WINDOW_SIZE_MS = 60000 // 1 minute
const SLIDE_THRESHOLD_MULTIPLIER = 2

/**
 * A sliding window counter strategy that provides smoother throttling than a fixed window.
 * It uses a weighted average of the current and previous window counts.
 * @implements {BaseStrategy}
 */
class SlidingWindowStrategy extends BaseStrategy {
    static strategyType = 'sliding-window'

    /**
     * @param {object} [options={}]
     * @param {number} [options.limit=10] - Max events allowed in the window.
     * @param {number} [options.windowSize=60000] - Window size in milliseconds (default 1 minute).
     */
    constructor (options = {}) {
        super()
        this.limit = options.limit ?? DEFAULT_LIMIT
        this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE_MS
    }

    /**
   * @override
   */
    async track (record, eventData) {
        const now = Date.now()
        let updatedRecord = record

        if (!updatedRecord) {
            const config = {
                limit: this.limit,
                windowSize: this.windowSize,
                deferInterval: this.tracker.config.deferInterval
            }
            updatedRecord = {
                ...this._createBaseRecord(eventData, now, this.tracker.config.expireTime),
                config,
                strategyData: {
                    currentCount: 1,
                    previousCount: 0,
                    windowStart: now
                }
            }
            return { outcome: 'immediate', record: updatedRecord }
        }

        const { limit, windowSize, deferInterval } = updatedRecord.config
        let { currentCount, previousCount, windowStart } = updatedRecord.strategyData

        const elapsed = now - windowStart

        // If window has passed, slide it
        if (elapsed >= windowSize) {
            if (elapsed >= windowSize * SLIDE_THRESHOLD_MULTIPLIER) {
                previousCount = 0
            } else {
                previousCount = currentCount
            }
            currentCount = 0
            // Align windowStart to the boundary
            windowStart = now - (elapsed % windowSize)
        }

        // Weighted average: current + previous * (% of previous window overlapping with current window)
        const weight = (windowSize - (now - windowStart)) / windowSize
        const estimatedCount = currentCount + (previousCount * weight)

        if (estimatedCount < limit) {
            currentCount += 1
            updatedRecord.count = Math.floor(estimatedCount + 1)
            updatedRecord.lastEventTime = now
            updatedRecord.expiresAt = now + this.tracker.config.expireTime
            updatedRecord.deferred = false
            updatedRecord.scheduledSendAt = null
            updatedRecord.strategyData = { currentCount, previousCount, windowStart }
            return { outcome: 'immediate', record: updatedRecord }
        } else {
            updatedRecord.deferred = true
            updatedRecord.lastEventTime = now
            // Extend expiry so an actively rate-limited stream keeps its record alive.
            updatedRecord.expiresAt = now + this.tracker.config.expireTime
            updatedRecord.scheduledSendAt = now + deferInterval
            updatedRecord.strategyData = { currentCount, previousCount, windowStart }
            return { outcome: 'deferred', record: updatedRecord }
        }
    }
}

module.exports = SlidingWindowStrategy
