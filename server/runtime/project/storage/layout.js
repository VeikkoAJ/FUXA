/**
 *  Maps project rows to files and back.
 *
 *  Every table is a (name, value) key/value store. A row becomes either a
 *  single JSON file or a directory of files, chosen so that the large string
 *  payloads (view SVG markup, script sources) land in real .svg and .js files
 *  instead of being escaped into one line of JSON.
 */

'use strict';

const J = require('./canonical');

const TableType = {
    GENERAL: 'general',
    DEVICES: 'devices',
    VIEWS: 'views',
    DEVICESSECURITY: 'devicesSecurity',
    TEXTS: 'texts',
    ALARMS: 'alarms',
    NOTIFICATIONS: 'notifications',
    SCRIPTS: 'scripts',
    REPORTS: 'reports',
    LOCATIONS: 'locations',
    ARMARKERS: 'arMarkers',
};

/**
 * A plain row is one JSON file holding the raw value, which may be an object,
 * an array or a bare scalar - the 'general' table stores the version as a string.
 */
function plainTable(dir) {
    return {
        dir,
        kind: 'file',
        explode: (value) => [{ rel: '', content: J.stringify(value) }],
        implode: (read) => J.parse(read('')),
    };
}

/**
 * views/<slug>/
 *   view.json   everything except the drawing and its bindings
 *   items.json  gauge bindings, keyed by the SVG element id they attach to
 *   view.svg    the drawing, as real SVG
 *
 * Views of type 'cards' and 'maps' keep a JSON string in svgcontent rather than
 * markup, so they get cards.json / maps.json instead. Those two files are
 * written without key sorting: re-stringifying them has to reproduce the
 * original string byte for byte, and the app built it with JSON.stringify, so
 * property order is already canonical.
 */
const viewsTable = {
    dir: 'views',
    kind: 'dir',
    explode: (value) => {
        const rest = Object.assign({}, value);
        delete rest.svgcontent;
        delete rest.items;
        const files = [{ rel: 'view.json', content: J.stringify(rest) }];
        if ('items' in value) {
            files.push({ rel: 'items.json', content: J.stringify(value.items) });
        }
        if ('svgcontent' in value) {
            files.push(explodeSvgContent(value));
        }
        return files;
    },
    implode: (read) => {
        const value = J.parse(read('view.json'));
        const items = read('items.json');
        if (items !== null) {
            value.items = J.parse(items);
        }
        for (const rel of ['cards.json', 'maps.json']) {
            const packed = read(rel);
            if (packed !== null) {
                value.svgcontent = JSON.stringify(J.parse(packed));
                return value;
            }
        }
        const svg = read('view.svg');
        if (svg !== null) {
            value.svgcontent = J.decodeText(svg);
        }
        return value;
    },
};

function explodeSvgContent(value) {
    const content = value.svgcontent;
    if (typeof content === 'string' && (value.type === 'cards' || value.type === 'maps')) {
        try {
            // Pretty printed but not reordered, so the round trip is exact.
            return { rel: `${value.type}.json`, content: JSON.stringify(JSON.parse(content), null, 2) + '\n' };
        } catch (err) {
            // Not the JSON we expected, fall through and keep it verbatim.
        }
    }
    return { rel: 'view.svg', content: J.encodeText(content) };
}

/**
 * devices/<slug>/device.json + tags.json - tags are the half that churns.
 */
const devicesTable = {
    dir: 'devices',
    kind: 'dir',
    explode: (value) => {
        const rest = Object.assign({}, value);
        delete rest.tags;
        const files = [{ rel: 'device.json', content: J.stringify(rest) }];
        if ('tags' in value) {
            files.push({ rel: 'tags.json', content: J.stringify(value.tags) });
        }
        return files;
    },
    implode: (read) => {
        const value = J.parse(read('device.json'));
        const tags = read('tags.json');
        if (tags !== null) {
            value.tags = J.parse(tags);
        }
        return value;
    },
};

/**
 * scripts/<slug>/script.json + script.js - the source becomes a real .js file,
 * so editors lint and highlight it and diffs are line based.
 */
const scriptsTable = {
    dir: 'scripts',
    kind: 'dir',
    explode: (value) => {
        const rest = Object.assign({}, value);
        delete rest.code;
        const files = [{ rel: 'script.json', content: J.stringify(rest) }];
        if ('code' in value) {
            files.push({ rel: 'script.js', content: J.encodeText(value.code) });
        }
        return files;
    },
    implode: (read) => {
        const value = J.parse(read('script.json'));
        const code = read('script.js');
        if (code !== null) {
            value.code = J.decodeText(code);
        }
        return value;
    },
};

const LAYOUT = {
    [TableType.GENERAL]: plainTable('general'),
    [TableType.VIEWS]: viewsTable,
    [TableType.DEVICES]: devicesTable,
    [TableType.SCRIPTS]: scriptsTable,
    [TableType.TEXTS]: plainTable('texts'),
    [TableType.ALARMS]: plainTable('alarms'),
    [TableType.NOTIFICATIONS]: plainTable('notifications'),
    [TableType.REPORTS]: plainTable('reports'),
    [TableType.LOCATIONS]: plainTable('mapsLocations'),
    [TableType.ARMARKERS]: plainTable('arMarkers'),
    // devicesSecurity is deliberately absent: it holds credentials and is kept
    // outside the workspace so it can never be committed.
};

/**
 * The human readable part of a path. Rows in 'general' are named by their key
 * ('version', 'layout', ...), everything else carries a display name in the
 * value. The row name, which is the entity id, is the fallback and the
 * tie breaker.
 */
function labelFor(table, name, value) {
    if (table === TableType.GENERAL) {
        return name;
    }
    if (value && typeof value === 'object' && typeof value.name === 'string' && value.name.trim()) {
        return value.name;
    }
    return name;
}

function layoutFor(table) {
    return LAYOUT[table] || null;
}

module.exports = {
    TableType,
    layoutFor,
    labelFor,
    tables: () => Object.keys(LAYOUT),
};
