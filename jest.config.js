module.exports = {
    testEnvironment: 'node',
    verbose: true,
    coveragePathIgnorePatterns: [
        '/node_modules/',
        '/examples/',
        '/__tests__/setup/'
    ],
    testMatch: [
        '**/__tests__/**/*.test.js'
    ],
    globalSetup: './__tests__/setup/globalSetup.js'
}
