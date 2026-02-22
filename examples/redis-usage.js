const { createClient } = require('redis')
const EventTracker = require('../index')
const RedisAdapter = require('../storage/RedisAdapter')

// Import the script definitions required by the adapter
const { scripts } = RedisAdapter

async function run () {
    // 1. Create a Redis client, configuring it with the required scripts.
    const redisClient = createClient({
        database: 1, // Use a separate database for the example
        scripts // Load the scripts into the client
    })
    await redisClient.connect()
    await redisClient.flushDb()

    console.log('--- Setting up tracker with Redis and automatic processing ---')
    const processor = async (events) => {
        console.log(`\n[PROCESSOR] Automatically processing ${events.length} event(s).`)
        events.forEach(e => console.log(` -> Event: ${e.category}/${e.id}`))
    }

    // 2. Create the EventTracker, passing the configured client to the adapter.
    const tracker = new EventTracker({
        storage: new RedisAdapter({ redisClient }),
        limit: 3,
        deferInterval: 2000,
        processor,
        processingInterval: 1000
    })

    tracker.on('immediate', (r) => console.log(`[EVENT] Immediate: ${r.category}/${r.id} (Count: ${r.count})`))
    tracker.on('deferred', (r) => console.log(`[EVENT] Deferred: ${r.category}/${r.id}`))
    tracker.on('ignored', (i) => console.log(`[EVENT] Ignored: ${i.reason}`))

    console.log('\n--- Simulating traffic with Redis backend ---')
    const details = { source: 'app-instance-1' }

    await tracker.trackEvent('api_error', 'db_connection_fail', details)
    await tracker.trackEvent('api_error', 'db_connection_fail', details)
    await tracker.trackEvent('api_error', 'db_connection_fail', details)
    await tracker.trackEvent('api_error', 'db_connection_fail', details) // Will be deferred

    const deferred = await tracker.getDeferredEvents()
    console.log(`\nFound ${deferred.length} deferred event(s) before automatic processing.`)

    console.log('\n--- Waiting for automatic processing (3 seconds) ---')
    await new Promise(resolve => setTimeout(resolve, 3000))

    const deferredAfter = await tracker.getDeferredEvents()
    console.log(`\nFound ${deferredAfter.length} deferred event(s) after processing window.`)

    await redisClient.quit()
    tracker.destroy()
}

run().catch(console.error)
