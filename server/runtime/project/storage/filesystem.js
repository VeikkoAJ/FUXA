/**
 *  Project datastore backed by a folder of ordinary files.
 *
 *  Implements the same seven operations as the sqlite backend, so
 *  runtime/project/index.js cannot tell the difference. The point is that the
 *  result is reviewable: views are .svg files, scripts are .js files, and every
 *  edit made in the application rewrites exactly the files it touched.
 *
 *  A manifest, .fuxa-index.json, maps each stored row to its files. It is what
 *  lets a rename show up as a rename, and what keeps clearAll() from deleting
 *  anything it did not create - the workspace is expected to hold a .git
 *  directory and a README that are none of our business.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const J = require('./canonical');
const { TableType, layoutFor, labelFor } = require('./layout');

const INDEX_FILE = '.fuxa-index.json';
const SECRETS_FILE = 'project.secrets.json';
const FORMAT_VERSION = 1;

var settings;
var logger;
var workspace;      // absolute path of the project folder
var secretsFile;    // absolute path, deliberately outside the workspace
var manifest;       // { formatVersion, rows: [ { table, name, path, kind, files, hash } ] }
var byKey;          // Map 'table\u0000name' -> manifest row

function _key(table, name) {
    return `${table}\u0000${name}`;
}

function _ensureValidTable(table) {
    if (!Object.values(TableType).includes(table)) {
        throw new Error(`invalid table '${table}'`);
    }
    return table;
}

function _abs(relative) {
    return path.join(workspace, relative);
}

// ---------------------------------------------------------------- manifest

function _reindex() {
    byKey = new Map();
    for (const row of manifest.rows) {
        byKey.set(_key(row.table, row.name), row);
    }
}

function _loadManifest() {
    const text = J.readFileOrNull(path.join(workspace, INDEX_FILE));
    if (text === null) {
        manifest = { formatVersion: FORMAT_VERSION, rows: [] };
        _reindex();
        return false;
    }
    try {
        const parsed = J.parse(text);
        manifest = {
            formatVersion: parsed.formatVersion || FORMAT_VERSION,
            rows: Array.isArray(parsed.rows) ? parsed.rows : [],
        };
        _reindex();
        return true;
    } catch (err) {
        // Without the manifest we cannot say what is stored, so report the
        // workspace as empty and let the caller seed a default project. The
        // files already on disk are left alone, and since the workspace is
        // meant to live in git, the manifest can be restored from there.
        logger.error(`prjstorage.fs manifest unreadable, starting empty! ${err}`);
        manifest = { formatVersion: FORMAT_VERSION, rows: [] };
        _reindex();
        return false;
    }
}

/**
 * The manifest is written last, so a crash mid save leaves it pointing at the
 * previous consistent state rather than at a half written row.
 */
function _saveManifest() {
    // rows is an array so that insertion order survives: it is the order views
    // are listed in, and sorted keys would scramble it.
    const content = JSON.stringify({
        formatVersion: manifest.formatVersion,
        rows: manifest.rows.map((row) => J.sortKeys(row)),
    }, null, 2) + '\n';
    J.writeFileAtomic(path.join(workspace, INDEX_FILE), content);
}

/**
 * The workspace is meant to become a git repository, so give a new one a
 * .gitignore covering the temporary files an interrupted write can leave.
 * Written once, on creation, and never touched again.
 */
function _seedGitignore() {
    const file = path.join(workspace, '.gitignore');
    if (fs.existsSync(file)) {
        return;
    }
    J.writeFileAtomic(file, [
        '# Partial writes left behind by an interrupted save.',
        '*.tmp',
        '',
    ].join('\n'));
}

// ---------------------------------------------------------------- secrets

/**
 * Device credentials never enter the workspace. They stay in workDir next to
 * the sqlite database, with owner only permissions.
 */
function _readSecrets() {
    const text = J.readFileOrNull(secretsFile);
    if (text === null) {
        return {};
    }
    try {
        return J.parse(text);
    } catch (err) {
        logger.error(`prjstorage.fs secrets unreadable! ${err}`);
        return {};
    }
}

function _writeSecrets(all) {
    J.writeFileAtomic(secretsFile, J.stringify(all));
    try {
        fs.chmodSync(secretsFile, 0o600);
    } catch (err) {
        // Best effort: some filesystems, notably on Windows, do not support it.
    }
}

// ---------------------------------------------------------------- paths

/**
 * Work out where a row lives. Reuses the row's current location when the
 * derived slug has not changed, so ordinary edits never move a file.
 */
function _resolvePath(table, name, value) {
    const layout = layoutFor(table);
    const existing = byKey.get(_key(table, name));
    // Compare slugs, not filenames: a single file row is stored as '<slug>.json',
    // and comparing 'high' against 'high.json' would never match, letting two
    // entities of the same name overwrite each other.
    const toSlug = (relative) => {
        const base = path.basename(relative);
        return (layout.kind === 'file' ? base.replace(/\.json$/, '') : base).toLowerCase();
    };
    const taken = new Set();
    for (const row of manifest.rows) {
        if (row.table === table && row.name !== name) {
            taken.add(toSlug(row.path));
        }
    }
    const label = labelFor(table, name, value);
    const slug = J.uniqueSlug(label, name, taken);
    const base = layout.kind === 'file' ? `${slug}.json` : slug;
    const relative = path.posix.join(layout.dir, base);
    return { relative, existing, layout };
}

// ---------------------------------------------------------------- api

/**
 * Bind the workspace, creating it when missing.
 * Resolves true when a project is already stored there.
 */
function init(_settings, _log) {
    settings = _settings;
    logger = _log;

    return new Promise(function (resolve, reject) {
        try {
            const configured = (settings.project && settings.project.workspaceDir) || '_project';
            workspace = path.isAbsolute(configured) ? configured : path.join(settings.workDir, configured);
            secretsFile = path.join(settings.workDir, SECRETS_FILE);
            fs.mkdirSync(workspace, { recursive: true });
            const existed = _loadManifest();
            if (!existed) {
                _seedGitignore();
            }
            logger.info(`prjstorage.connected-to ${workspace} workspace`, true);
            resolve(existed);
        } catch (err) {
            logger.error(`prjstorage.bind failed! ${err}`);
            reject(err);
        }
    });
}

function close() {
    // Every write is flushed synchronously, so there is nothing to drain.
}

function setDefault() {
    return setSections([
        { table: TableType.GENERAL, name: 'version', value: '1.00' },
        { table: TableType.DEVICES, name: 'server', value: { 'id': '0', 'name': 'FUXA Server', 'type': 'FuxaServer', 'property': {} } },
    ]);
}

/**
 * Write one row. Synchronous underneath, so concurrent calls from the runtime
 * cannot interleave and leave the manifest describing a row that is half saved.
 */
function _writeRow(section) {
    const table = _ensureValidTable(section.table);
    const value = section.value;

    if (table === TableType.DEVICESSECURITY) {
        const all = _readSecrets();
        all[section.name] = value;
        _writeSecrets(all);
        return;
    }

    const { relative, existing, layout } = _resolvePath(table, section.name, value);
    const produced = layout.explode(value);

    // A rename moves the whole entity, so git reports it as a rename.
    if (existing && existing.path !== relative) {
        J.removeQuiet(_abs(existing.path));
        J.pruneEmptyDirs(path.dirname(_abs(existing.path)), workspace);
    }

    const files = [];
    let digest = '';
    for (const file of produced) {
        const rel = file.rel ? path.posix.join(relative, file.rel) : relative;
        J.writeFileAtomic(_abs(rel), file.content);
        files.push(file.rel);
        digest += `${file.rel}\u0000${file.content}\u0000`;
    }

    // Drop files this row used to own but no longer produces, for instance the
    // items.json of a view that lost its bindings. Anything the user added
    // alongside is left alone, because it was never in the manifest.
    if (existing && existing.path === relative && Array.isArray(existing.files)) {
        for (const stale of existing.files) {
            if (!files.includes(stale)) {
                J.removeQuiet(_abs(stale ? path.posix.join(relative, stale) : relative));
            }
        }
    }

    const row = {
        table,
        name: section.name,
        path: relative,
        kind: layout.kind,
        files,
        hash: J.hash(digest),
    };
    if (existing) {
        Object.assign(existing, row);
    } else {
        manifest.rows.push(row);
        byKey.set(_key(table, section.name), row);
    }
}

function setSection(section) {
    return new Promise(function (resolve, reject) {
        try {
            _writeRow(section);
            _saveManifest();
            resolve();
        } catch (err) {
            logger.error(`prjstorage.set failed! ${err}`);
            reject(err);
        }
    });
}

function setSections(sections) {
    return new Promise(function (resolve, reject) {
        try {
            for (const section of sections) {
                _writeRow(section);
            }
            _saveManifest();
            resolve();
        } catch (err) {
            logger.error(`prjstorage.set failed! ${err}`);
            reject(err);
        }
    });
}

function _readRow(row) {
    const layout = layoutFor(row.table);
    const base = _abs(row.path);
    const read = (rel) => J.readFileOrNull(rel ? path.join(base, rel) : base);
    return { name: row.name, value: JSON.stringify(layout.implode(read)) };
}

/**
 * Return every row of a table, or just the named one.
 * Rows come back in the order they were added, matching the sqlite backend,
 * which is what fixes the order views appear in.
 */
function getSection(table, name) {
    return new Promise(function (resolve, reject) {
        try {
            const safeTable = _ensureValidTable(table);

            if (safeTable === TableType.DEVICESSECURITY) {
                const all = _readSecrets();
                const names = name ? (Object.prototype.hasOwnProperty.call(all, name) ? [name] : []) : Object.keys(all);
                resolve(names.map((key) => ({ name: key, value: JSON.stringify(all[key]) })));
                return;
            }

            const rows = [];
            for (const row of manifest.rows) {
                if (row.table !== safeTable || (name && row.name !== name)) {
                    continue;
                }
                try {
                    rows.push(_readRow(row));
                } catch (err) {
                    // One unreadable entity must not take the whole project down.
                    logger.error(`prjstorage.get failed for ${row.table}/${row.path}! ${err}`);
                }
            }
            resolve(rows);
        } catch (err) {
            reject(err);
        }
    });
}

function deleteSection(section) {
    return new Promise(function (resolve, reject) {
        try {
            const table = _ensureValidTable(section.table);

            if (table === TableType.DEVICESSECURITY) {
                const all = _readSecrets();
                delete all[section.name];
                _writeSecrets(all);
                resolve();
                return;
            }

            const key = _key(table, section.name);
            const existing = byKey.get(key);
            if (existing) {
                J.removeQuiet(_abs(existing.path));
                J.pruneEmptyDirs(path.dirname(_abs(existing.path)), workspace);
                manifest.rows = manifest.rows.filter((row) => row !== existing);
                byKey.delete(key);
                _saveManifest();
            }
            resolve();
        } catch (err) {
            logger.error(`prjstorage.delete failed! ${err}`);
            reject(err);
        }
    });
}

/**
 * Remove every row this backend created. Files the manifest does not list -
 * .git, .gitignore, README - are left untouched, which matters because
 * clearAll runs on every whole project upload.
 *
 * Device credentials are not cleared, matching the sqlite backend. Here that
 * needs no special case: they live outside the workspace and never appear in
 * the manifest.
 */
function clearAll() {
    return new Promise(function (resolve, reject) {
        try {
            for (const row of manifest.rows) {
                J.removeQuiet(_abs(row.path));
                J.pruneEmptyDirs(path.dirname(_abs(row.path)), workspace);
            }
            manifest.rows = [];
            _reindex();
            _saveManifest();
            resolve(true);
        } catch (err) {
            logger.error(`prjstorage.clear failed! ${err}`);
            reject(err);
        }
    });
}

module.exports = {
    init,
    close,
    clearAll,
    getSection,
    setSections,
    setSection,
    deleteSection,
    setDefault,
    TableType,
    // exposed for the converter and the workspace status api
    _internals: {
        workspacePath: () => workspace,
        manifest: () => manifest,
    },
};
