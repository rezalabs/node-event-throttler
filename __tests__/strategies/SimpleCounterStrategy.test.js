const SimpleCounterStrategy = require('../../strategies/SimpleCounterStrategy')

describe('SimpleCounterStrategy', () => {
    let strategy
    let mockTracker

    beforeEach(() => {
        strategy = new SimpleCounterStrategy()
        mockTracker = {
            config: {
                limit: 2,
                deferInterval: 1000,
                expireTime: 5000
            }
        }
        strategy.tracker = mockTracker // Manually inject mock tracker
    })

    it('should return "immediate" for the first event', async () => {
        const eventData = { compositeKey: 'key1', category: 'cat', id: 'id1', details: {}, detailsHash: '' }
        const { outcome, record } = await strategy.track(undefined, eventData)

        expect(outcome).toBe('immediate')
        expect(record.count).toBe(1)
        expect(record.deferred).toBe(false)
    })

    it('should return "immediate" for events under the limit', async () => {
        const eventData = { compositeKey: 'key1' }
        const existingRecord = { key: 'key1', count: 1, config: mockTracker.config }
        const { outcome, record } = await strategy.track(existingRecord, eventData)

        expect(outcome).toBe('immediate')
        expect(record.count).toBe(2)
    })

    it('should return "deferred" when the limit is exceeded', async () => {
        const eventData = { compositeKey: 'key1' }
        const existingRecord = { key: 'key1', count: 2, config: mockTracker.config }
        const { outcome, record } = await strategy.track(existingRecord, eventData)

        expect(outcome).toBe('deferred')
        expect(record.count).toBe(3)
        expect(record.deferred).toBe(true)
        expect(record.scheduledSendAt).toBeGreaterThan(Date.now())
    })

    it('should return "ignored" for an already deferred event without incrementing count', async () => {
        const eventData = { compositeKey: 'key1' }
        const existingRecord = { key: 'key1', count: 3, deferred: true, config: mockTracker.config }
        const { outcome, record } = await strategy.track(existingRecord, eventData)

        expect(outcome).toBe('ignored')
        // Count must not be inflated — ignored events are not real forward-progress.
        expect(record.count).toBe(3)
        expect(record.deferred).toBe(true)
    })
})
