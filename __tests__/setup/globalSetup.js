const { createClient } = require('redis')

/**
 * Global setup for Jest tests. This script runs once before all test suites.
 * It connects to Redis and flushes the test database to ensure a clean state.
 */
module.exports = async () => {
    console.log('\n[Jest Global Setup] Connecting to Redis to flush test database...')

    const client = createClient({
    // Use a dedicated database for testing to avoid conflicts with development data.
    // Make sure your local Redis instance is running.
        database: 15,
        socket: {
            connectTimeout: 2000 // 2 seconds timeout
        }
    })

    // Suppress unhandled 'error' events emitted by the redis Commander before the
    // connect() promise rejects. Without this listener Node.js throws a fatal error.
    client.on('error', () => {})

    try {
        await client.connect()
        await client.flushDb()
        console.log('[Jest Global Setup] Test Redis DB (15) flushed successfully.')
        process.env.REDIS_AVAILABLE = 'true'
    } catch (err) {
        console.warn(
            '[Jest Global Setup] Warning: Failed to connect to Redis.',
            'Redis integration tests will be skipped.',
            'Error:', err.message
        )
        process.env.REDIS_AVAILABLE = 'false'
    } finally {
        if (client.isOpen) {
            await client.disconnect()
        }
    }
}
