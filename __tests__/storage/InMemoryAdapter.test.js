const InMemoryAdapter = require('../../storage/InMemoryAdapter')

describe('InMemoryAdapter', () => {
    let adapter

    beforeEach(() => {
        adapter = new InMemoryAdapter({ purgeInterval: 0 }) // Disable automatic purging for tests
    })

    afterEach(() => {
        adapter.destroy()
    })

    it('should set and get a record', async () => {
        const record = { key: 'test1', data: 'value' }
        await adapter.set('test1', record)
        const result = await adapter.get('test1')
        expect(result).toEqual(record)
    })

    it('should return undefined for a nonexistent record', async () => {
        const result = await adapter.get('nonexistent')
        expect(result).toBeUndefined()
    })

    it('should delete a record', async () => {
        await adapter.set('test1', { key: 'test1' })
        await adapter.delete('test1')
        const result = await adapter.get('test1')
        expect(result).toBeUndefined()
    })

    it('should correctly report its size', async () => {
        expect(await adapter.size()).toBe(0)
        await adapter.set('test1', { key: 'test1' })
        await adapter.set('test2', { key: 'test2' })
        expect(await adapter.size()).toBe(2)
    })

    it('should atomically update a record', async () => {
        const originalRecord = { key: 'updateme', count: 1, config: {} }
        await adapter.set('updateme', originalRecord)
        const wasUpdated = await adapter.update('updateme', (rec) => {
            rec.count += 1
            return rec
        })
        expect(wasUpdated).toBe(true)
        const updatedRecord = await adapter.get('updateme')
        expect(updatedRecord.count).toBe(2)
    })

    it('should find due deferred records', async () => {
        const now = Date.now()
        const past = now - 1000
        const future = now + 1000
        await adapter.set('due', { key: 'due', deferred: true, scheduledSendAt: past })
        await adapter.set('not-due', { key: 'not-due', deferred: true, scheduledSendAt: future })
        await adapter.set('not-deferred', { key: 'not-deferred', deferred: false, scheduledSendAt: past })

        const dueRecords = await adapter.findDueDeferred(now)
        expect(dueRecords).toHaveLength(1)
        expect(dueRecords[0].key).toBe('due')
    })

    it('should pop due deferred records, removing them from storage', async () => {
        const now = Date.now()
        await adapter.set('due', { key: 'due', deferred: true, scheduledSendAt: now - 1 })
        expect(await adapter.size()).toBe(1)
        const popped = await adapter.popDueDeferred(now)
        expect(popped).toHaveLength(1)
        expect(popped[0].key).toBe('due')
        expect(await adapter.size()).toBe(0)
    })

    it('should find all deferred records', async () => {
        await adapter.set('deferred1', { key: 'deferred1', deferred: true })
        await adapter.set('deferred2', { key: 'deferred2', deferred: true })
        await adapter.set('not-deferred', { key: 'not-deferred', deferred: false })

        const allDeferred = await adapter.findAllDeferred()
        expect(allDeferred).toHaveLength(2)
    })

    it('should respect key limit acquisition logic', async () => {
        await adapter.set('key1', {})
        const canAcquireNew = await adapter.acquireKeySlot('key2', 2)
        expect(canAcquireNew).toBe(true)

        // Manually set the second key to correctly occupy the slot before the next check.
        await adapter.set('key2', {})
        expect(await adapter.size()).toBe(2)

        const cannotAcquireNew = await adapter.acquireKeySlot('key3', 2)
        expect(cannotAcquireNew).toBe(false)

        const canAcquireExisting = await adapter.acquireKeySlot('key1', 2)
        expect(canAcquireExisting).toBe(true)
    })

    it('should track an event atomically', async () => {
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
})
