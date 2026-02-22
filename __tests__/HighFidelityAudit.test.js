const EventTracker = require('../index')
const InMemoryAdapter = require('../storage/InMemoryAdapter')

describe('Test Engineering - High Fidelity Audit', () => {
    describe('InMemoryAdapter - Expired Record Tracking (High Fidelity)', () => {
        it('should strictly reset state for expired records even if still in memory', async () => {
            const adapter = new InMemoryAdapter({ purgeInterval: 0 })
            // Use 1ms expireTime to force immediate expiration
            const tracker = new EventTracker({ storage: adapter, expireTime: 1 })

            // 1. Establish state
            await tracker.trackEvent('fidelity', 'test', { v: 1 })
            const recKey = EventTracker.generateCompositeKey('fidelity', 'test')
            const rec1 = await adapter.get(recKey)

            // 2. Wait 10ms to be absolutely sure
            await new Promise(resolve => setTimeout(resolve, 10))
            const nowAfter = Date.now()

            // 3. Track again - should be treated as NEW (count resets to 1)
            const res2 = await tracker.trackEvent('fidelity', 'test', { v: 1 })
            expect(res2.data.count).toBe(1)
            expect(nowAfter).toBeGreaterThan(rec1.expiresAt)

            tracker.destroy()
        })
    })

    describe('EventTracker - Real Time Drifts & Accuracy', () => {
        it('should handle rapid concurrent events without dropping (In-Memory)', async () => {
            const tracker = new EventTracker({ limit: 100 })
            const tasks = []
            for (let i = 0; i < 50; i++) {
                tasks.push(tracker.trackEvent('stress', '1'))
            }
            const results = await Promise.all(tasks)
            const counts = results.map(r => r.data.count)
            // Check for uniqueness in counts to ensure serial consistency or atomicity
            const uniqueCounts = new Set(counts)
            expect(uniqueCounts.size).toBe(50)
            expect(Math.max(...counts)).toBe(50)

            tracker.destroy()
        })
    })

    describe('Edge Case: Deep Copy Integrity for Dates & Maps', () => {
        it('should prevent mutation of Date objects in details', async () => {
            const adapter = new InMemoryAdapter()
            const date = new Date('2026-01-01')
            const details = { timestamp: date }

            await adapter.set('date-test', {
                key: 'date-test',
                details,
                expiresAt: Date.now() + 1000,
                deferred: false
            })

            const retrieved = await adapter.get('date-test')
            retrieved.details.timestamp.setFullYear(2030) // Attempt mutation

            const secondRetrieved = await adapter.get('date-test')
            expect(secondRetrieved.details.timestamp.getFullYear()).toBe(2026)

            adapter.destroy()
        })
    })
})
