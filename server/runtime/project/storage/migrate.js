/**
 *  Moves a project between the two storage backends.
 *
 *  Both backends are the same key/value store, so a conversion is a straight
 *  copy of every row: no format knowledge is needed here, the layout rules live
 *  in layout.js and apply on write.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { TableType } = require('./layout');

/**
 * Read every row of every table.
 */
async function readAll(backend) {
    const sections = [];
    for (const table of Object.values(TableType)) {
        const rows = await backend.getSection(table);
        for (const row of rows || []) {
            sections.push({ table, name: row.name, value: JSON.parse(row.value) });
        }
    }
    return sections;
}

/**
 * Copy every row from one initialized backend into another.
 * Returns the number of rows copied.
 */
async function copy(from, to) {
    const sections = await readAll(from);
    if (sections.length) {
        await to.setSections(sections);
    }
    return sections.length;
}

/**
 * True when a sqlite project database is present for these settings.
 */
function sqliteProjectExists(settings) {
    return fs.existsSync(path.join(settings.workDir, 'project.fuxap.db'));
}

/**
 * Seed a freshly created workspace from an existing sqlite project.
 * Called on first start after switching settings.project.storage to 'fs'.
 * The database is only read, never modified, so the switch stays reversible.
 * Returns the number of rows imported, or 0 when there was nothing to import.
 */
async function seedWorkspaceFromSqlite(settings, logger, workspaceBackend) {
    if (!sqliteProjectExists(settings)) {
        return 0;
    }
    const sqlite = require('./sqlite');
    logger.info('prjstorage.converting project.fuxap.db into the workspace', true);
    await sqlite.init(settings, logger);
    try {
        const count = await copy(sqlite, workspaceBackend);
        logger.info(`prjstorage.converted ${count} project sections into the workspace`, true);
        return count;
    } finally {
        sqlite.close();
    }
}

module.exports = {
    readAll,
    copy,
    sqliteProjectExists,
    seedWorkspaceFromSqlite,
};
