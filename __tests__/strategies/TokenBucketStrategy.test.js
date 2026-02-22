const TokenBucketStrategy = require('../../strategies/TokenBucketStrategy')

describe('TokenBucketStrategy', () => {
    let strategy
    let mockTracker

    beforeEach(() => {
        strategy = new TokenBucketStrategy({ bucketSize: 5, refillRate: 10 }) // 10 tokens/sec
        mockTracker = {
            config: {
                expireTime: 5000
            }
        }
        strategy.tracker = mockTracker
    })

    it('should create a new record and consume one token on the first event', async () => {
        const eventData = { compositeKey: 'key1', category: 'cat', id: 'id1', details: {}, detailsHash: '' }
        const { outcome, record } = await strategy.track(undefined, eventData)

        expect(outcome).toBe('immediate')
        expect(record.count).toBe(1)
        expect(record.strategyData.tokens).toBe(4) // 5 (bucketSize) - 1
    })

    it('should consume tokens for subsequent immediate events', async () => {
        const eventData = { compositeKey: 'key1' }
        const existingRecord = {
            key: 'key1',
            count: 1,
            config: { bucketSize: 5, refillRate: 10 },
            strategyData: { tokens: 4, lastRefill: Date.now() }
        }
        const { outcome, record } = await strategy.track(existingRecord, eventData)
        expect(outcome).toBe('immediate')
        expect(record.strategyData.tokens).toBeCloseTo(3)
    })

    it('should refill tokens based on elapsed time', async () => {
        const lastRefill = Date.now() - 500 // 0.5 seconds ago
        const eventData = { compositeKey: 'key1' }
        const existingRecord = {
            key: 'key1',
            count: 1,
            config: { bucketSize: 10, refillRate: 10 }, // 10 tokens/sec
            strategyData: { tokens: 0, lastRefill }
        }
        // After 0.5s, 5 tokens should have been refilled (0.5s * 10 tokens/s)
        const { outcome, record } = await strategy.track(existingRecord, eventData)
        expect(outcome).toBe('immediate')
        // 0 initial + 5 refilled - 1 consumed = 4
        expect(record.strategyData.tokens).toBeCloseTo(4)
    })

    it('should defer when no tokens are available', async () => {
        const eventData = { compositeKey: 'key1' }
        const existingRecord = {
            key: 'key1',
            count: 5,
            config: { bucketSize: 5, refillRate: 1 },
            strategyData: { tokens: 0, lastRefill: Date.now() }
        }
        const { outcome, record } = await strategy.track(existingRecord, eventData)
        expect(outcome).toBe('deferred')
        expect(record.deferred).toBe(true)
        // Should be scheduled for ~1 second in the future (1 token / 1 token/sec)
        expect(record.scheduledSendAt).toBeCloseTo(Date.now() + 1000, -2)
    })

    it('should maintain floating point precision for tokens', async () => {
        const strategySlow = new TokenBucketStrategy({ bucketSize: 5, refillRate: 0.5 })
        strategySlow.tracker = mockTracker
        const lastRefill = Date.now() - 500 // 0.25 tokens refilled
        const eventData = { compositeKey: 'key1' }
        const existingRecord = {
            key: 'key1',
            count: 1,
            config: { bucketSize: 5, refillRate: 0.5 },
            strategyData: { tokens: 0.5, lastRefill }
        }
        // 0.5 initial + 0.25 refilled = 0.75. Not enough for a token.
        const { outcome, record } = await strategySlow.track(existingRecord, eventData)
        expect(outcome).toBe('deferred')
        expect(record.strategyData.tokens).toBeCloseTo(0.75)
    })
})
