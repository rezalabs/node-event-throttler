const EventTracker = require('../index')
const InMemoryAdapter = require('../storage/InMemoryAdapter')

describe('Chaos Engineering - Robustness & Edge Cases', () => {
    describe('EventTracker - Details Hash & Circular References', () => {
        test('should handle circular references in details without crashing', () => {
            // generateDetailsHash is a static method — no tracker instance needed.
            const details = { name: 'test' }
            details.self = details // Circular reference

            // Should NOT throw anymore
            const hash = EventTracker.generateDetailsHash(details)
            expect(hash).toBe('')
        })
    })

    describe('EventTracker - Processor Failures & Data Loss', () => {
        test('events should be lost if processor fails and no DLQ is implemented', async () => {
            const tracker = new EventTracker({
                storage: new InMemoryAdapter(),
                limit: 1,
                deferInterval: 0, // Immediate deferral for second event
                maxRetries: 0 // Disable retries for this test
            })

            // Suppress unhandled error log during this test
            tracker.on('error', () => {})

            tracker.setProcessor(async (events) => {
                throw new Error('Processor failed!')
            })

            // Track first event (immediate)
            await tracker.trackEvent('test', '1')
            // Track second event (deferred because limit is 1)
            await tracker.trackEvent('test', '1')

            const deferred = await tracker.getDeferredEvents()
            expect(deferred.length).toBe(1)

            // Attempt to process
            const failedPromise = new Promise((resolve) => {
                tracker.on('process_failed', ({ events }) => {
                    resolve(events)
                })
            })

            await tracker.processDeferredEvents()
            const failedEvents = await failedPromise

            expect(failedEvents.length).toBe(1)

            // Critical check: are they gone from storage?
            const deferredAfter = await tracker.getDeferredEvents()
            expect(deferredAfter.length).toBe(0) // They are lost from storage!

            tracker.destroy()
        })
    })

    describe('InMemoryAdapter - Shallow Copy Issues', () => {
        test('modifying returned record details should not affect stored state (but it currently does due to shallow copy)', async () => {
            const adapter = new InMemoryAdapter()
            const key = 'test-key'
            const details = { metadata: { source: 'web' } }
            const record = {
                key,
                details,
                expiresAt: Date.now() + 10000,
                deferred: false
            }

            await adapter.set(key, record)

            const retrieved = await adapter.get(key)
            retrieved.details.metadata.source = 'mobile' // Modify nested object

            const secondRetrieval = await adapter.get(key)
            // It should now be 'web' because we fixed it with deep cloning
            expect(secondRetrieval.details.metadata.source).toBe('web')

            adapter.destroy()
        })
    })

    describe('EventTracker - Config Validation', () => {
        test('should throw on invalid configuration types', () => {
            expect(() => new EventTracker({ limit: -1 })).toThrow('limit must be non-negative.')
            expect(() => new EventTracker({ limit: '5' })).toThrow('limit must be a number.')
        })
    })

    describe('EventTracker - Key Limit Exhaustion', () => {
        test('should ignore events when maxKeys is reached', async () => {
            const tracker = new EventTracker({
                maxKeys: 2
            })

            await tracker.trackEvent('c', '1')
            await tracker.trackEvent('c', '2')

            const result = await tracker.trackEvent('c', '3')
            expect(result.type).toBe('ignored')
            expect(result.reason).toBe('key_limit_reached')

            tracker.destroy()
        })
    })

    describe('EventTracker - Relentless Edge Cases', () => {
        test('should throw TypeError if category or id are not strings', async () => {
            const tracker = new EventTracker()
            await expect(tracker.trackEvent(null, 'id')).rejects.toThrow(TypeError)
            await expect(tracker.trackEvent('cat', 123)).rejects.toThrow(TypeError)
            tracker.destroy()
        })

        test('should handle extremely high processing interval correctly', async () => {
            const tracker = new EventTracker({ processingInterval: 0 })
            // Should be clamped to minimum 10ms
            expect(tracker.processingIntervalMs).toBe(10)
            tracker.destroy()
        })
    })
})
