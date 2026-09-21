/**
 *  Project datastore.
 *
 *  Two interchangeable backends implement the same seven operations over a
 *  (name, value) key/value store:
 *
 *    'sqlite'  the default, one binary project.fuxap.db file
 *    'fs'      a folder of ordinary JSON, SVG and JS files, meant to be put
 *              under version control and edited in an editor
 *
 *  Chosen with settings.project.storage. Callers see no difference, so
 *  runtime/project/index.js is written against this interface alone.
 */

'use strict';

const { TableType } = require('./storage/layout');

// Loaded on demand: sqlite3 is a native module, and a workspace backed project
// should not need it to have been built.
const BACKENDS = {
    sqlite: () => require('./storage/sqlite'),
    fs: () => require('./storage/filesystem'),
};

var backend = null;

/**
 * Select the backend and bind its resource.
 * Resolves true when a project is already stored, false when it needs seeding.
 */
function init(_settings, _log) {
    const requested = (_settings && _settings.project && _settings.project.storage) || 'sqlite';
    const load = BACKENDS[requested];
    if (!load) {
        _log.error(`prjstorage.unknown-storage '${requested}', falling back to sqlite`);
        backend = BACKENDS.sqlite();
    } else {
        backend = load();
    }
    if (requested !== 'fs') {
        return backend.init(_settings, _log);
    }
    // Switching an existing installation to workspace storage: import the
    // database once, so nobody has to convert by hand. The database is left in
    // place and untouched, which keeps the switch reversible.
    return backend.init(_settings, _log).then(async (existed) => {
        if (existed) {
            return true;
        }
        const migrate = require('./storage/migrate');
        try {
            return (await migrate.seedWorkspaceFromSqlite(_settings, _log, backend)) > 0;
        } catch (err) {
            _log.error(`prjstorage.workspace-seed failed! ${err}`);
            return false;
        }
    });
}

function _active() {
    if (!backend) {
        // Nothing selected yet, which means init has not run.
        backend = BACKENDS.sqlite();
    }
    return backend;
}

module.exports = {
    init: init,
    close: (...args) => _active().close(...args),
    clearAll: (...args) => _active().clearAll(...args),
    getSection: (...args) => _active().getSection(...args),
    setSections: (...args) => _active().setSections(...args),
    setSection: (...args) => _active().setSection(...args),
    deleteSection: (...args) => _active().deleteSection(...args),
    setDefault: (...args) => _active().setDefault(...args),
    TableType: TableType,
    /** The active backend, for the converter tool and the workspace status api. */
    current: _active,
};
