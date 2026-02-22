const SlidingWindowStrategy = require('../../strategies/SlidingWindowStrategy')

describe('SlidingWindowStrategy', () => {
    let strategy

    beforeEach(() => {
        strategy = new SlidingWindowStrategy({ limit: 10, windowSize: 1000 })
        strategy.tracker = { config: { expireTime: 5000, deferInterval: 500 } }
    })

    it('should allow events within the limit in the first window', async () => {
        const eventData = { compositeKey: 'k', detailsHash: 'h' }
        let res = await strategy.track(undefined, eventData)
        expect(res.outcome).toBe('immediate')
        expect(res.record.count).toBe(1)

        for (let i = 0; i < 8; i++) {
            res = await strategy.track(res.record, eventData)
        }
        expect(res.outcome).toBe('immediate')
        expect(res.record.count).toBe(9)

        res = await strategy.track(res.record, eventData)
        expect(res.outcome).toBe('immediate')
        expect(res.record.count).toBe(10)

        res = await strategy.track(res.record, eventData)
        expect(res.outcome).toBe('deferred')
    })

    it('should slide the window and allow more events', async () => {
        jest.useFakeTimers()
        const eventData = { compositeKey: 'k', detailsHash: 'h' }

        // Fill up first window
        let res = await strategy.track(undefined, eventData)
        for (let i = 0; i < 9; i++) {
            res = await strategy.track(res.record, eventData)
        }
        expect(res.outcome).toBe('immediate')

        // Advance by half a window
        jest.advanceTimersByTime(500)
        // weight is 0.5, so estimated count is 10 + 0 = 10?
        // Wait, in my impl: weight = (1000 - 500) / 1000 = 0.5
        // estimated = current (0) + previous (0) * 0.5 = 0. No, currentCount is still in the same window.

        res = await strategy.track(res.record, eventData)
        expect(res.outcome).toBe('deferred')

        // Advance to next window
        jest.advanceTimersByTime(501) // total 1001ms

        // now current window is empty, previous window had 10.
        // weight = (1000 - 1) / 1000 = 0.999
        // estimated = 0 + 10 * 0.999 = 9.99
        res = await strategy.track(res.record, eventData)
        expect(res.outcome).toBe('immediate') // 9.99 < 10
        expect(res.record.count).toBe(10) // floor(9.99 + 1)

        res = await strategy.track(res.record, eventData)
        expect(res.outcome).toBe('deferred') // estimated is now 1 + 10*0.999 > 10

        jest.useRealTimers()
    })
})
