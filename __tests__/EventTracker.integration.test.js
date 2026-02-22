const EventTracker = require('../index')
const InMemoryAdapter = require('../storage/InMemoryAdapter')

describe('EventTracker Integration', () => {
    let tracker

    beforeEach(() => {
        // Use an in-memory adapter for simple testing
        tracker = new EventTracker({
            storage: new InMemoryAdapter(),
            limit: 2,
            deferInterval: 100,
            expireTime: 200
        })
    })

    afterEach(() => {
        tracker.destroy()
    })

    it('should track events and defer when limit is exceeded', async () => {
        let res = await tracker.trackEvent('auth', 'login_fail')
        expect(res.type).toBe('immediate')
        expect(res.data.count).toBe(1)

        res = await tracker.trackEvent('auth', 'login_fail')
        expect(res.type).toBe('immediate')
        expect(res.data.count).toBe(2)

        res = await tracker.trackEvent('auth', 'login_fail')
        expect(res.type).toBe('deferred')
        expect(res.data.count).toBe(3)
        expect(res.data.deferred).toBe(true)

        res = await tracker.trackEvent('auth', 'login_fail')
        expect(res.type).toBe('ignored')
    })

    it('should process deferred events via callback', async () => {
        jest.useFakeTimers()
        const processor = jest.fn().mockResolvedValue()
        tracker.setProcessor(processor)

        await tracker.trackEvent('api', 'err-1')
        await tracker.trackEvent('api', 'err-1')
        await tracker.trackEvent('api', 'err-1') // deferred

        expect(processor).not.toHaveBeenCalled()

        // Manually trigger processing loop
        jest.advanceTimersByTime(150)
        await tracker.processDeferredEvents()

        expect(processor).toHaveBeenCalledTimes(1)
        const processedEvents = processor.mock.calls[0][0]
        expect(processedEvents).toHaveLength(1)
        expect(processedEvents[0].id).toBe('err-1')
        jest.useRealTimers()
    })

    it('should emit process_failed event when processor throws', async () => {
        jest.useFakeTimers()

        // Create a tracker with no retries for this test
        const testTracker = new EventTracker({
            storage: new InMemoryAdapter(),
            limit: 2,
            deferInterval: 100,
            expireTime: 200,
            maxRetries: 0 // Disable retries for immediate failure
        })

        const error = new Error('Simulated processing failure')
        const processor = jest.fn().mockRejectedValue(error)
        testTracker.setProcessor(processor)

        // Setup event listener for the failure
        const failureHandler = jest.fn()
        testTracker.on('process_failed', failureHandler)
        testTracker.on('error', () => {}) // Prevent unhandled error event from crashing

        await testTracker.trackEvent('api', 'fail-1')
        await testTracker.trackEvent('api', 'fail-1')
        await testTracker.trackEvent('api', 'fail-1') // deferred

        jest.advanceTimersByTime(150)
        await testTracker.processDeferredEvents()

        expect(processor).toHaveBeenCalled()
        expect(failureHandler).toHaveBeenCalledTimes(1)
        const payload = failureHandler.mock.calls[0][0]
        expect(payload.error).toBe(error)
        expect(payload.events).toHaveLength(1)
        expect(payload.events[0].id).toBe('fail-1')

        testTracker.destroy()
        jest.useRealTimers()
    })

    it('should reset event count if details change', async () => {
        await tracker.trackEvent('auth', 'login_fail', { ip: '1.1.1.1' })
        let res = await tracker.trackEvent('auth', 'login_fail', { ip: '1.1.1.1' })
        expect(res.data.count).toBe(2)

        // Now track with different details
        res = await tracker.trackEvent('auth', 'login_fail', { ip: '2.2.2.2' })
        expect(res.type).toBe('immediate')
        expect(res.data.count).toBe(1)
    })

    it('should respect the maxKeys limit', async () => {
        const limitedTracker = new EventTracker({ storage: new InMemoryAdapter(), maxKeys: 2 })

        let res = await limitedTracker.trackEvent('cat', 'id1')
        expect(res.type).not.toBe('ignored')

        res = await limitedTracker.trackEvent('cat', 'id2')
        expect(res.type).not.toBe('ignored')

        // At limit, should be ignored
        res = await limitedTracker.trackEvent('cat', 'id3')
        expect(res.type).toBe('ignored')
        expect(res.reason).toBe('key_limit_reached')

        // Existing keys can still be tracked
        res = await limitedTracker.trackEvent('cat', 'id1')
        expect(res.type).not.toBe('ignored')

        limitedTracker.destroy()
    })

    it('should update config atomically', async () => {
        await tracker.trackEvent('dynamic', 'config-test')
        let record = await tracker.storage.get(EventTracker.generateCompositeKey('dynamic', 'config-test'))
        expect(record.config.limit).toBe(2)

        const result = await tracker.updateConfig('dynamic', 'config-test', { limit: 5 })
        expect(result).toBe(true)

        record = await tracker.storage.get(EventTracker.generateCompositeKey('dynamic', 'config-test'))
        expect(record.config.limit).toBe(5)
    })
})
