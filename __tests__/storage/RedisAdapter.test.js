const { createClient } = require('redis')
const RedisAdapter = require('../../storage/RedisAdapter')

const describeIfRedis = process.env.REDIS_AVAILABLE === 'true' ? describe : describe.skip

describeIfRedis('RedisAdapter', () => {
    let client
    let adapter

    beforeAll(async () => {
        client = createClient({ database: 15, scripts: RedisAdapter.scripts })
        await client.connect()
        adapter = new RedisAdapter({ redisClient: client })
    })

    beforeEach(async () => {
        await client.flushDb()
    })

    afterAll(async () => {
        if (client && client.isOpen) {
            await client.disconnect()
        }
    })

    it('should set and get a complete record', async () => {
        const record = {
            key: 'test1',
            category: 'cat',
            id: 'id1',
            details: { a: 1 },
            detailsHash: 'hash1',
            count: 1,
            lastEventTime: Date.now(),
            expiresAt: Date.now() + 10000,
            deferred: false,
            scheduledSendAt: null,
            config: { limit: 5 },
            strategyData: { tokens: 4 }
        }
        await adapter.set('test1', record)
        const result = await adapter.get('test1')
        expect(result).toEqual(record)
    })

    it('should atomically update a record using WATCH/MULTI/EXEC', async () => {
        const originalRecord = {
            key: 'updateme',
            count: 1,
            category: 'cat',
            id: 'id1',
            details: {},
            detailsHash: '',
            lastEventTime: Date.now(),
            expiresAt: Date.now() + 10000,
            deferred: false,
            scheduledSendAt: null,
            config: { limit: 5 }
        }
        await adapter.set('updateme', originalRecord)
        const wasUpdated = await adapter.update('updateme', (rec) => {
            rec.count += 1
            return rec
        })
        expect(wasUpdated).toBe(true)
        const updatedRecord = await adapter.get('updateme')
        expect(updatedRecord.count).toBe(2)
    })

    it('should handle popDueDeferred correctly', async () => {
        const now = Date.now()
        const dueRecord = {
            key: 'due1',
            category: 'cat',
            id: 'id1',
            details: {},
            detailsHash: '',
            count: 1,
            lastEventTime: now,
            expiresAt: now + 10000,
            deferred: true,
            scheduledSendAt: now - 100,
            config: {}
        }
        await adapter.set('due1', dueRecord)
        expect(await adapter.size()).toBe(1)
        const popped = await adapter.popDueDeferred(now)
        expect(popped).toHaveLength(1)
        expect(popped[0].key).toBe('due1')
        const recordAfterPop = await adapter.get('due1')
        expect(recordAfterPop).toBeUndefined()
        expect(await adapter.size()).toBe(0)
    })

    it('should manage size correctly with incr/decr', async () => {
        expect(await adapter.size()).toBe(0)
        await adapter.set('key1', { key: 'key1', expiresAt: Date.now() + 1000, deferred: false, details: {}, config: {} })
        expect(await adapter.size()).toBe(1)
        await adapter.set('key2', { key: 'key2', expiresAt: Date.now() + 1000, deferred: false, details: {}, config: {} })
        expect(await adapter.size()).toBe(2)
        await adapter.delete('key1')
        expect(await adapter.size()).toBe(1)
    })

    it('should acquire key slot using the defined script', async () => {
        const canAcquire1 = await adapter.acquireKeySlot('key1', 2)
        expect(canAcquire1).toBe(true)
        await adapter.set('key1', { key: 'key1', expiresAt: Date.now() + 1000 })

        const canAcquire2 = await adapter.acquireKeySlot('key2', 2)
        expect(canAcquire2).toBe(true)
        await adapter.set('key2', { key: 'key2', expiresAt: Date.now() + 1000 })

        const cannotAcquire3 = await adapter.acquireKeySlot('key3', 2)
        expect(cannotAcquire3).toBe(false)
    })

    it('should track an event atomically using the track script', async () => {
        const SimpleCounterStrategy = require('../../strategies/SimpleCounterStrategy')
        const strategy = new SimpleCounterStrategy()
        strategy.tracker = { config: { limit: 2, deferInterval: 1000, expireTime: 5000, maxKeys: 0 } }

        const eventData = { category: 'test', id: '1', details: { foo: 'bar' }, detailsHash: 'hash' }
        const trackerConfig = strategy.tracker.config

        // First track
        let res = await adapter.track('test:1', eventData, trackerConfig, strategy)
        expect(res.outcome).toBe('immediate')
        expect(res.record.count).toBe(1)

        // Second track
        res = await adapter.track('test:1', eventData, trackerConfig, strategy)
        expect(res.outcome).toBe('immediate')
        expect(res.record.count).toBe(2)

        // Third track (deferred)
        res = await adapter.track('test:1', eventData, trackerConfig, strategy)
        expect(res.outcome).toBe('deferred')
        expect(res.record.count).toBe(3)
        expect(res.record.deferred).toBe(true)
    })

    it('should track an event using sliding-window strategy in Redis', async () => {
        const SlidingWindowStrategy = require('../../strategies/SlidingWindowStrategy')
        const strategy = new SlidingWindowStrategy({ limit: 2, windowSize: 1000 })
        strategy.tracker = { config: { expireTime: 5000, deferInterval: 1000, maxKeys: 0 } }

        const eventData = { category: 'sw', id: '1', details: {}, detailsHash: 'h' }
        const trackerConfig = strategy.tracker.config

        // First track
        let res = await adapter.track('sw:1', eventData, trackerConfig, strategy)
        expect(res.outcome).toBe('immediate')
        expect(res.record.count).toBe(1)

        // Second track
        res = await adapter.track('sw:1', eventData, trackerConfig, strategy)
        expect(res.outcome).toBe('immediate')
        expect(res.record.count).toBe(2)

        // Third track (deferred)
        res = await adapter.track('sw:1', eventData, trackerConfig, strategy)
        expect(res.outcome).toBe('deferred')
    })
})
