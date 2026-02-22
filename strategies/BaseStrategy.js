/**
 * @typedef {import('../storage/BaseAdapter').EventRecord} EventRecord
 * @typedef {import('../index').EventTracker} EventTracker
 */

/**
 * Base class for all throttling strategies.
 * Defines the interface that the EventTracker engine uses.
 */
class BaseStrategy {
    /**
     * The strategy type identifier used for serialization.
     * Must be overridden by subclasses.
     * @type {string}
     */
    static strategyType = 'base'

    /**
     * The initial event count assigned to every new record.
     * Centralised here so subclasses share a single source of truth.
     * @type {number}
     */
    static INITIAL_EVENT_COUNT = 1

    constructor () {
        /** @type {EventTracker} */
        this.tracker = null
    }

    /**
     * Returns the strategy type identifier.
     * @returns {string}
     */
    getStrategyType () {
        return this.constructor.strategyType || 'simple'
    }

    /**
     * Creates the base EventRecord fields shared by every strategy.
     * Subclasses spread this into their record object and add strategy-specific
     * fields (`config`, `strategyData`) on top.
     * @protected
     * @param {object} eventData - Raw event data from the adapter.
     * @param {number} now - Current timestamp (ms). Callers must pass a single
     *   consistent value so all timestamp fields within one track() call agree.
     * @param {number} expireTime - TTL in milliseconds.
     * @returns {EventRecord}
     */
    _createBaseRecord (eventData, now, expireTime) {
        const { compositeKey, category, id, details, detailsHash } = eventData
        return {
            key: compositeKey,
            category,
            id,
            details,
            detailsHash,
            count: BaseStrategy.INITIAL_EVENT_COUNT,
            lastEventTime: now,
            expiresAt: now + expireTime,
            deferred: false,
            scheduledSendAt: null
        }
    }

    /**
   * Processes an event and determines the outcome based on the strategy's rules.
   * This method must be implemented by all subclasses.
   * @param {EventRecord | undefined} record - The existing record, or undefined if new.
   * @param {object} eventData - The raw data for the incoming event.
   * @returns {Promise<{outcome: 'immediate'|'deferred'|'ignored', record: EventRecord}>}
   */
    async track (record, eventData) {
        throw new Error('Strategy.track() must be implemented by subclasses.')
    }
}

module.exports = BaseStrategy
