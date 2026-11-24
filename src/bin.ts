#!/usr/bin/env node
// Runs React in production mode unless NODE_ENV is set explicitly.
// The app is imported dynamically so this assignment precedes ink/react.
process.env.NODE_ENV ??= "production"

await import("./cli.js")
