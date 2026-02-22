/**
 * @typedef {object} EventRecord
 * @property {string} key - Hashed composite key.
 * @property {string} category - High-level grouping of the event.
 * @property {string} id - Specific identifier within the category.
 * @property {object} details - The original event details object.
 * @property {string} detailsHash - SHA256 hash of the sorted event details.
 * @property {number} count - Current count of this event in the window.
 * @property {number} lastEventTime - Timestamp of the last recorded event.
 * @property {number} expiresAt - Timestamp when this record is considered expired.
 * @property {boolean} deferred - True if the event is deferred.
 * @property {number|null} scheduledSendAt - Timestamp for next processing attempt.
 * @property {object} config - A snapshot of the tracker/strategy config for this record.
 * @property {object} [strategyData] - State used by the throttling strategy (e.g., token count).
 */

/**
 * Defines the interface for all storage adapters.
 * This class should not be instantiated directly.
 */
class BaseAdapter {
    /**
     * Retrieves a record by its key.
     * @param {string} key - The composite key of the event.
     * @returns {Promise<EventRecord|undefined>}
     */
    async get (key) { throw new Error('Adapter must implement get()') }

    /**
     * Stores or updates a record.
     * @param {string} key - The composite key of the event.
     * @param {EventRecord} record - The event record to store.
     * @returns {Promise<void>}
     */
    async set (key, record) { throw new Error('Adapter must implement set()') }

    /**
     * Deletes a record by its key.
     * @param {string} key - The composite key of the event.
     * @returns {Promise<void>}
     */
    async delete (key) { throw new Error('Adapter must implement delete()') }

    /**
     * Atomically updates a record.
     * @param {string} key - The key of the record to update.
     * @param {(record: EventRecord) => EventRecord} updateFn - A function that modifies the record.
     * @returns {Promise<boolean>} True if the record was found and updated.
     */
    async update (key, updateFn) { throw new Error('Adapter must implement update()') }

    /**
     * Returns the number of records in the store.
     * @returns {Promise<number>}
     */
    async size () { throw new Error('Adapter must implement size()') }

    /**
     * Atomically acquires a slot for a new key if under the maxKeys limit.
     * @param {string} key - The key to potentially add.
     * @param {number} maxKeys - The maximum number of keys allowed.
     * @returns {Promise<boolean>} True if the key already exists or was added successfully.
     */
    async acquireKeySlot (key, maxKeys) { throw new Error('Adapter must implement acquireKeySlot()') }

    /**
     * Finds all records that are deferred and due for processing.
     * @param {number} timestamp - The current timestamp to check against.
     * @returns {Promise<EventRecord[]>}
     */
    async findDueDeferred (timestamp) { throw new Error('Adapter must implement findDueDeferred()') }

    /**
     * Atomically finds, returns, and deletes all due deferred events.
     * @param {number} timestamp - The current timestamp to check against.
     * @returns {Promise<EventRecord[]>}
     */
    async popDueDeferred (timestamp) { throw new Error('Adapter must implement popDueDeferred()') }

    /**
     * Performs an atomic track operation.
     * This should be overridden by adapters to ensure atomicity.
     * @param {string} key - The composite key.
     * @param {object} eventData - Data about the event (category, id, details, detailsHash).
     * @param {object} trackerConfig - The tracker's global configuration.
     * @param {BaseStrategy} strategy - The strategy instance.
     * @returns {Promise<{outcome: 'immediate'|'deferred'|'ignored', record: EventRecord, reason?: string}>}
     */
    async track (key, eventData, trackerConfig, strategy) {
        throw new Error('Adapter must implement track()')
    }

    /**
     * Finds all deferred records, regardless of whether they are due.
     * @returns {Promise<EventRecord[]>}
     */
    async findAllDeferred () { throw new Error('Adapter must implement findAllDeferred()') }

    /**
     * Cleans up resources.
     */
    destroy () {}
}

module.exports = BaseAdapter
