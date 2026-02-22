const BaseStrategy = require('./BaseStrategy')

/**
 * A simple counter-based strategy that defers after a limit is reached.
 * @implements {BaseStrategy}
 */
class SimpleCounterStrategy extends BaseStrategy {
    static strategyType = 'simple'

    /**
     * @override
     */
    async track (record, eventData) {
        const now = Date.now()
        let updatedRecord = record

        if (!updatedRecord) {
            // Create a new record using the tracker's default configuration
            const config = {
                limit: this.tracker.config.limit,
                deferInterval: this.tracker.config.deferInterval
            }
            updatedRecord = {
                ...this._createBaseRecord(eventData, now, this.tracker.config.expireTime || 0),
                config
            }
        } else {
            // Fast path: already deferred — extend expiry so an active but rate-limited
            // event stream does not cause the record to expire mid-deferral, then bail
            // without touching count or lastEventTime.
            if (updatedRecord.deferred) {
                updatedRecord.expiresAt = now + (this.tracker.config.expireTime || 0)
                return { outcome: 'ignored', record: updatedRecord }
            }

            updatedRecord.count += 1
            updatedRecord.lastEventTime = now
            // Always extend the expiration time on activity
            updatedRecord.expiresAt = now + (this.tracker.config.expireTime || 0)
        }

        // Use the limit from the record's own config, allowing for runtime updates.
        if (updatedRecord.count > updatedRecord.config.limit) {
            updatedRecord.deferred = true
            updatedRecord.scheduledSendAt = now + updatedRecord.config.deferInterval
            return { outcome: 'deferred', record: updatedRecord }
        }

        return { outcome: 'immediate', record: updatedRecord }
    }
}

module.exports = SimpleCounterStrategy
