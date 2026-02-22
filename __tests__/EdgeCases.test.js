const EventTracker = require('../index')
const InMemoryAdapter = require('../storage/InMemoryAdapter')

describe('EventTracker Edge Cases', () => {
    let tracker

    afterEach(() => {
        if (tracker) {
            tracker.destroy()
        }
    })

    it('should handle zero limit correctly (block all)', async () => {
        tracker = new EventTracker({
            limit: 0, // Should block everything immediately
            storage: new InMemoryAdapter()
        })

        const res = await tracker.trackEvent('test', 'id1')
        expect(res.type).toBe('deferred')
        expect(res.data.count).toBe(1)
    })

    it('should handle large payloads gracefully', async () => {
        tracker = new EventTracker({ storage: new InMemoryAdapter() })
        const largeDetails = { data: 'a'.repeat(10000) } // 10KB string

        const res = await tracker.trackEvent('test', 'large', largeDetails)
        expect(res.type).toBe('immediate')

        const compositeKey = EventTracker.generateCompositeKey('test', 'large')
        const record = await tracker.storage.get(compositeKey)
        expect(record).toBeDefined()
        expect(record.details.data).toBe(largeDetails.data)
    })

    it('should stop processor loop when destroyed', async () => {
        jest.useFakeTimers()
        const processor = jest.fn().mockResolvedValue()
        tracker = new EventTracker({
            processor,
            processingInterval: 100,
            storage: new InMemoryAdapter()
        })

        const spy = jest.spyOn(tracker, 'processDeferredEvents')

        // Advance time once to ensure loop is running/scheduled
        jest.advanceTimersByTime(105)
        // At this point, processDeferredEvents should have been called once
        expect(spy).toHaveBeenCalledTimes(1)

        tracker.destroy()

        // Advance time again - it should NOT be called a second time
        jest.advanceTimersByTime(200)
        expect(spy).toHaveBeenCalledTimes(1) // Still 1

        jest.useRealTimers()
    })

    it('should handle tracking when record is expired but not yet purged', async () => {
        jest.useFakeTimers()
        tracker = new EventTracker({
            expireTime: 1000, // Use a larger value but consistent
            storage: new InMemoryAdapter({ purgeInterval: 0 }) // Disable auto purge
        })

        // Track twice so count is 2
        await tracker.trackEvent('test', 'id1')
        const res1 = await tracker.trackEvent('test', 'id1')
        expect(res1.data.count).toBe(2)

        // Advance time past expiration (1000ms)
        jest.advanceTimersByTime(1100)

        // Track same event. Logic should treat it as new because it's expired.
        const res2 = await tracker.trackEvent('test', 'id1')
        expect(res2.data.count).toBe(1) // Reset to 1 because expired

        jest.useRealTimers()
    })

    it('should not throw if storage is empty when popping due events', async () => {
        tracker = new EventTracker()
        const events = await tracker.processDeferredEvents()
        expect(events).toEqual([])
    })
})
