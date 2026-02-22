const EventTracker = require('../index')

// Example: Configure a tracker that is very sensitive for demonstration.
// - Defer after just 2 events.
// - An event record expires after 10 seconds of inactivity.
// - A deferred event can be reprocessed after 5 seconds.
const tracker = new EventTracker({
    limit: 2,
    expireTime: 10 * 1000,
    deferInterval: 5 * 1000
})

const FAILED_LOGIN_DETAILS = { reason: 'invalid_credentials' }
const USER_ID = 'user-api-007'
const CATEGORY = 'authentication'

function logResult (attempt, result) {
    console.log(
        `[Attempt ${attempt}] Result: ${result.type.padEnd(10)} | Count: ${result.data?.count ?? 1} | Deferred: ${result.data?.deferred ?? false}`
    )
}

async function run () {
    console.log('--- Simulating an event flood ---')
    // 1. First event is immediate
    logResult(1, await tracker.trackEvent(CATEGORY, USER_ID, FAILED_LOGIN_DETAILS))
    // 2. Second event is immediate
    logResult(2, await tracker.trackEvent(CATEGORY, USER_ID, FAILED_LOGIN_DETAILS))
    // 3. Third event exceeds the limit and is deferred
    logResult(3, await tracker.trackEvent(CATEGORY, USER_ID, FAILED_LOGIN_DETAILS))
    // 4. Fourth event is ignored because the key is already deferred
    logResult(4, await tracker.trackEvent(CATEGORY, USER_ID, FAILED_LOGIN_DETAILS))

    console.log('\n--- Waiting for deferral period to pass (6 seconds) ---')
    await new Promise(resolve => setTimeout(resolve, 6000))

    console.log('\n--- Manually processing due events ---')
    // When no processor callback is provided, this method returns due events without deleting them.
    // For automatic processing and deletion, provide a `processor` callback in the constructor.
    const dueEvents = await tracker.processDeferredEvents()
    if (dueEvents.length > 0) {
        console.log(`Found ${dueEvents.length} due event(s).`)
        console.log('Example due event:', dueEvents[0])
        // Manually delete after processing
        for (const event of dueEvents) {
            await tracker.storage.delete(event.key)
        }
        console.log('Manually deleted processed events.')
    } else {
        console.log('No events were due for processing.')
    }

    console.log('\n--- Tracking the same event again after processing ---')
    // After being processed and deleted, the record is gone. The next event starts a new count.
    logResult(5, await tracker.trackEvent(CATEGORY, USER_ID, FAILED_LOGIN_DETAILS))

    // Finally, clean up the tracker's resources (like the background purge timer).
    tracker.destroy()
}

run().catch(console.error)
