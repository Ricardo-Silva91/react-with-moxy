#!/usr/bin/env node

require('dotenv').config();

const path = require('path');
const yargs = require('yargs');
const planify = require('planify');
const pify = require('pify');
const internalIp = require('internal-ip');
const express = require('express');
const compression = require('compression');
const { render, renderError } = require('./middlewares/render');
const { read: readBuildManifest } = require('./util/manifest');
const { publicDir } = require('./util/constants');

// ---------------------------------------------------------
// CLI definition
// ---------------------------------------------------------

const argv = yargs
.strict()
.wrap(Math.min(120, yargs.terminalWidth()))
.help()
.alias('help', 'h')
.version()
.alias('version', 'v')
.usage('Usage: ./$0 [options]')
.option('host', {
    alias: 'H',
    type: 'string',
    default: process.env.HOST || process.env.HOSTNAME || '0.0.0.0',
    describe: 'The host to bind to',
})
.option('port', {
    alias: 'p',
    type: 'number',
    default: Number(process.env.PORT) || 3000,
    describe: 'The port to bind to',
})
.option('gzip', {
    alias: 'gz',
    type: 'boolean',
    default: process.env.GZIP !== '0',
    describe: 'Enable or disable gzip compression',
})
.option('reporter', {
    type: 'string',
    describe: 'Any of the planify\'s reporters',
})
.example('$0', 'Serves the last built application')
.example('$0 --port 8081', 'Serves the last built application on port 8081')
.argv;

// ---------------------------------------------------------
// Functions
// ---------------------------------------------------------

function prepare(data) {
    // Force ENV to production
    process.env.NODE_ENV = 'production';

    // Read the manifest & import the server code
    data.buildManifest = readBuildManifest();

    const serverFile = `${publicDir}/build/${data.buildManifest.server.file}`;

    try {
        data.exports = require(serverFile);
    } catch (err) {
        err.detail = `This error happened when loading the server file at ${path.relative('', serverFile)}`;
        err.hideStack = false;
        throw err;
    }

    process.stdout.write(`Build hash: ${data.buildManifest.hash}\n`);
    process.stdout.write(`Server build hash: ${data.buildManifest.server.hash}\n`);
}

async function runServer(data) {
    const { host, port, gzip } = argv;
    const app = express();

    // Configure express app
    app.set('etag', false); // Not necessary by default
    app.set('x-powered-by', false); // Remove x-powered-by header

    // Enable gzip compression
    gzip && app.use('/', compression());

    // Public files in /build have the following pattern: <file>.<hash>.<extension>
    // Therefore it's safe to cache them indefinitely
    app.use('/build', express.static(`${publicDir}/build`, {
        maxAge: 31557600000, // 1 year
        immutable: true, // No conditional requests
        etag: false, // Not necessary
        index: false, // Disable directory listing
        fallthrough: false, // Ensure that requests to /build do not propagate to other middleware
    }));

    // The rest of the public files are served using a more modest approach using etags
    app.use(express.static(publicDir, {
        index: false,
    }));

    // If it's not a public file, render the app!
    app.use(
        // There's no compilation to be done, just set the `res.locals`
        (req, res, next) => {
            res.locals.isomorphic = {
                exports: data.exports,
                buildManifest: data.buildManifest,
            };
            next();
        },
        // Setup the render middlewares that will call render() & renderError()
        render(),
        renderError()
    );

    // Start server
    await pify(app.listen).call(app, port, host);

    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
    const lanUrl = `http://${await internalIp.v4()}:${port}`;

    process.stdout.write(`Server address:            ${url}\n`);
    process.stdout.write(`LAN server address:        ${lanUrl}\n`);
    process.stdout.write(`Gzip compression:          ${gzip ? 'on' : 'off'}\n`);
    process.stdout.write('\nServer is now up and running, press CTRL-C to stop.\n');
}

// ---------------------------------------------------------
// Steps
// ---------------------------------------------------------

planify()
.step('Preparing', prepare)
.step('Running server', runServer)
.run({ reporter: argv.reporter })
.catch((err) => process.exit(err.exitCode || 1));
