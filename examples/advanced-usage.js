const EventTracker = require('../index')
const { TokenBucketStrategy } = EventTracker

async function run () {
    console.log('--- Phase 3: Advanced Features ---')

    // 1. Setup a processor callback to handle due events
    const processor = async (events) => {
        console.log(`\n[PROCESSOR CALLBACK] Received ${events.length} due event(s).`)
        events.forEach(e => {
            console.log(` -> Processing ${e.category}/${e.id} which occurred ${e.count} times.`)
        })
    }

    // 2. Instantiate with TokenBucketStrategy and the callback.
    // The tracker automatically injects itself into the strategy.
    const tracker = new EventTracker({
        strategy: new TokenBucketStrategy({
            bucketSize: 5, // Allow 5 events in a burst
            refillRate: 0.5 // Refill 0.5 tokens per second (1 token every 2s)
        }),
        processor, // The processor function for automatic handling
        processingInterval: 2000 // Check for due events every 2 seconds
    })

    tracker.on('error', (err) => console.error('Tracker error:', err))
    tracker.on('processed', (event) => console.log(`[EVENT] Processed ${event.category}/${event.id}`))

    console.log('\n--- Simulating event burst with Token Bucket ---')
    const details = { error: 'E_CONN_RESET' }
    // Send 7 events quickly. First 5 should be immediate, last 2 deferred.
    for (let i = 0; i < 7; i++) {
        const res = await tracker.trackEvent('network', 'service-A', details)
        console.log(`[Attempt ${i + 1}] Outcome: ${res.type}`)
        await new Promise(resolve => setTimeout(resolve, 200)) // 200ms between events
    }

    console.log('\n--- Using Dynamic Configuration ---')
    console.log('Updating limit for `service-A`...')
    // This will affect subsequent checks for service-A if it were a SimpleCounterStrategy.
    // Here we demonstrate updating a custom field on the config.
    await tracker.updateConfig('network', 'service-A', { customField: 'newValue' })
    console.log('Config for service-A updated.')
    const record = await tracker.storage.get(EventTracker.generateCompositeKey('network', 'service-A'))
    console.log('Updated record config:', record.config)

    console.log('\n--- Waiting for deferred events to be processed automatically ---')
    // We just wait, the interval processor will handle the rest.
    await new Promise(resolve => setTimeout(resolve, 5000))

    console.log('\n--- Shutting down ---')
    tracker.destroy()
}

run().catch(console.error)
