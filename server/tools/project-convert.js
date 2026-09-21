#!/usr/bin/env node
/**
 *  Convert a FUXA project between the sqlite database and the file workspace.
 *
 *    node tools/project-convert.js --to fs
 *    node tools/project-convert.js --to sqlite
 *    node tools/project-convert.js --verify
 *
 *  Neither direction deletes the source, so a conversion is always reversible.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const J = require('../runtime/project/storage/canonical');
const migrate = require('../runtime/project/storage/migrate');

const USAGE = `
Usage: node tools/project-convert.js --to <fs|sqlite> [options]
       node tools/project-convert.js --verify [options]

  --to <fs|sqlite>   Direction of the conversion.
  --verify           Round trip the project both ways in a temporary folder
                     and report whether every section survived unchanged.
  --workdir <dir>    Application data folder. Default ./_appdata
  --workspace <dir>  Workspace folder. Relative paths resolve against workdir.
                     Default _project
  --force            Overwrite a non empty destination.
`;

function parseArgs(argv) {
    const args = { workdir: path.resolve(process.cwd(), '_appdata'), workspace: '_project' };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--to') {
            args.to = argv[++i];
        } else if (arg === '--workdir') {
            args.workdir = path.resolve(argv[++i]);
        } else if (arg === '--workspace') {
            args.workspace = argv[++i];
        } else if (arg === '--verify') {
            args.verify = true;
        } else if (arg === '--force') {
            args.force = true;
        } else if (arg === '-h' || arg === '--help') {
            args.help = true;
        } else {
            throw new Error(`unknown argument '${arg}'`);
        }
    }
    return args;
}

const logger = {
    info: (msg) => console.log(msg),
    warn: (msg) => console.warn(msg),
    error: (msg) => console.error(msg),
    debug: () => {},
};

function settingsFor(args, overrides = {}) {
    return Object.assign({
        workDir: args.workdir,
        project: { storage: 'fs', workspaceDir: args.workspace },
    }, overrides);
}

/**
 * Fresh module instances, so the two backends in a round trip never share the
 * module level state each of them keeps.
 */
function loadBackend(name) {
    const file = require.resolve(`../runtime/project/storage/${name}`);
    delete require.cache[file];
    return require(file);
}

async function convert(args) {
    const settings = settingsFor(args);
    const workspace = path.isAbsolute(args.workspace) ? args.workspace : path.join(args.workdir, args.workspace);
    const database = path.join(args.workdir, 'project.fuxap.db');

    if (args.to === 'fs') {
        if (!fs.existsSync(database)) {
            throw new Error(`no project database at ${database}`);
        }
        if (!args.force && fs.existsSync(path.join(workspace, '.fuxa-index.json'))) {
            throw new Error(`workspace ${workspace} already holds a project, pass --force to overwrite`);
        }
        const source = loadBackend('sqlite');
        const target = loadBackend('filesystem');
        await source.init(settings, logger);
        await target.init(settings, logger);
        if (args.force) {
            await target.clearAll();
        }
        const count = await migrate.copy(source, target);
        source.close();
        target.close();
        console.log(`converted ${count} sections into ${workspace}`);
        return;
    }

    if (args.to === 'sqlite') {
        if (!fs.existsSync(path.join(workspace, '.fuxa-index.json'))) {
            throw new Error(`no workspace project at ${workspace}`);
        }
        if (!args.force && fs.existsSync(database)) {
            throw new Error(`${database} already exists, pass --force to overwrite`);
        }
        const source = loadBackend('filesystem');
        const target = loadBackend('sqlite');
        await source.init(settings, logger);
        await target.init(settings, logger);
        if (args.force) {
            await target.clearAll();
        }
        const count = await migrate.copy(source, target);
        source.close();
        target.close();
        console.log(`converted ${count} sections into ${database}`);
        return;
    }

    throw new Error(`--to expects 'fs' or 'sqlite'`);
}

/**
 * Read the live project, write it to a throwaway workspace, read it back and
 * compare. Reports the sections that differ rather than just a pass or fail,
 * so a regression points at the entity that broke.
 */
async function verify(args) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fuxa-verify-'));
    try {
        const database = path.join(args.workdir, 'project.fuxap.db');
        const workspace = path.isAbsolute(args.workspace) ? args.workspace : path.join(args.workdir, args.workspace);
        const fromDatabase = fs.existsSync(database);
        if (!fromDatabase && !fs.existsSync(path.join(workspace, '.fuxa-index.json'))) {
            throw new Error(`nothing to verify: no project at ${database} or ${workspace}`);
        }

        const source = loadBackend(fromDatabase ? 'sqlite' : 'filesystem');
        await source.init(settingsFor(args), logger);
        const original = await migrate.readAll(source);
        source.close();

        const roundTrip = loadBackend('filesystem');
        await roundTrip.init({ workDir: tmp, project: { storage: 'fs', workspaceDir: 'workspace' } }, logger);
        await roundTrip.setSections(original);
        const returned = await migrate.readAll(roundTrip);
        roundTrip.close();

        const problems = compare(original, returned);
        console.log(`checked ${original.length} sections via ${path.join(tmp, 'workspace')}`);
        if (!problems.length) {
            console.log('round trip is lossless');
            return 0;
        }
        for (const problem of problems) {
            console.error(`  ${problem}`);
        }
        console.error(`${problems.length} section(s) did not survive the round trip`);
        return 1;
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

function compare(original, returned) {
    const problems = [];
    const seen = new Map();
    for (const section of returned) {
        seen.set(`${section.table} ${section.name}`, section.value);
    }
    for (const section of original) {
        const key = `${section.table} ${section.name}`;
        if (!seen.has(key)) {
            problems.push(`${key}: missing after round trip`);
            continue;
        }
        // Key order is not meaningful - the workspace writes sorted keys - but
        // the string payloads inside must match byte for byte.
        const before = J.stringify(section.value);
        const after = J.stringify(seen.get(key));
        if (before !== after) {
            problems.push(`${key}: value changed (${before.length} -> ${after.length} bytes)`);
        }
        seen.delete(key);
    }
    for (const key of seen.keys()) {
        problems.push(`${key}: appeared out of nowhere`);
    }
    return problems;
}

async function main() {
    let args;
    try {
        args = parseArgs(process.argv.slice(2));
    } catch (err) {
        console.error(`${err.message}\n${USAGE}`);
        process.exit(2);
    }
    if (args.help || (!args.to && !args.verify)) {
        console.log(USAGE);
        process.exit(args.help ? 0 : 2);
    }
    try {
        process.exit(args.verify ? await verify(args) : (await convert(args), 0));
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
}

main();
