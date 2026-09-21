/**
 *  Canonical serialization helpers for the filesystem project storage.
 *  Everything written to the workspace goes through here so that saving an
 *  unchanged project produces byte-identical files and therefore an empty diff.
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Windows refuses these names with any extension, on every drive.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
// Characters no portable filesystem accepts, plus the C0 controls.
// eslint-disable-next-line no-control-regex
const ILLEGAL_CHARS = /[\u0000-\u001f\u007f<>:"/\\|?*]/g;
const MAX_SLUG_LENGTH = 64;

/**
 * Recursively sort object keys. Arrays keep their order, since order is
 * significant for charts, chart lines and script parameters.
 */
function sortKeys(value) {
    if (Array.isArray(value)) {
        return value.map(sortKeys);
    }
    if (value !== null && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortKeys(value[key]);
        }
        return sorted;
    }
    return value;
}

/**
 * Stable pretty JSON: sorted keys, 2 space indent, exactly one trailing newline.
 * Accepts any JSON value, including the bare strings the 'general' table holds.
 */
function stringify(value) {
    return JSON.stringify(sortKeys(value), null, 2) + '\n';
}

function parse(text) {
    return JSON.parse(text);
}

/**
 * Text payloads (SVG markup, script sources) are stored verbatim with one
 * newline appended, so the files stay POSIX clean. Reading strips exactly one
 * trailing newline, which makes the pair lossless in both directions.
 */
function encodeText(text) {
    return `${text == null ? '' : text}\n`;
}

function decodeText(text) {
    return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/**
 * Build a filesystem safe, human readable name. Ids stay authoritative, the
 * slug is only a label, so collisions are resolved by the caller.
 */
function slugify(name, fallback) {
    let slug = String(name === null || name === undefined ? '' : name).normalize('NFC');
    slug = slug.replace(ILLEGAL_CHARS, ' ');
    slug = slug.replace(/\s+/g, ' ').trim().replace(/ /g, '-');
    // Leading dots hide the file, trailing dots and spaces are dropped by Windows.
    slug = slug.replace(/^[.]+/, '').replace(/[.\s]+$/, '');
    if (slug.length > MAX_SLUG_LENGTH) {
        slug = slug.slice(0, MAX_SLUG_LENGTH).replace(/[-.\s]+$/, '');
    }
    if (RESERVED_NAMES.test(slug)) {
        slug += '-';
    }
    if (!slug) {
        slug = slugify(fallback, '') || 'item';
    }
    return slug;
}

/**
 * Pick a slug not already present in <taken>. Compared case insensitively so a
 * workspace authored on Linux still opens on macOS and Windows.
 */
function uniqueSlug(name, fallback, taken) {
    const base = slugify(name, fallback);
    if (!taken.has(base.toLowerCase())) {
        return base;
    }
    const suffix = slugify(fallback, '').slice(0, 8);
    if (suffix) {
        const withId = `${base}-${suffix}`;
        if (!taken.has(withId.toLowerCase())) {
            return withId;
        }
    }
    for (let i = 2; ; i++) {
        const candidate = `${base}-${i}`;
        if (!taken.has(candidate.toLowerCase())) {
            return candidate;
        }
    }
}

function hash(text) {
    return 'sha1:' + crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/**
 * Write via a temporary file and rename, so an interrupted write can never
 * leave a half written project file behind.
 */
function writeFileAtomic(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
        fs.writeFileSync(fd, content, 'utf8');
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

function readFileOrNull(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch (err) {
        if (err.code === 'ENOENT') {
            return null;
        }
        throw err;
    }
}

/**
 * Remove a file or directory tree, ignoring anything already gone.
 */
function removeQuiet(target) {
    try {
        fs.rmSync(target, { recursive: true, force: true });
    } catch (err) {
        if (err.code !== 'ENOENT') {
            throw err;
        }
    }
}

/**
 * Drop directories left empty after a removal, stopping at <stopAt>.
 */
function pruneEmptyDirs(dir, stopAt) {
    let current = path.resolve(dir);
    const root = path.resolve(stopAt);
    // Compare on a separator boundary, so '/w/views2' is not taken for a child of '/w/views'.
    const inside = (p) => p.startsWith(root + path.sep);
    while (inside(current)) {
        let entries;
        try {
            entries = fs.readdirSync(current);
        } catch (err) {
            return;
        }
        if (entries.length) {
            return;
        }
        try {
            fs.rmdirSync(current);
        } catch (err) {
            return;
        }
        current = path.dirname(current);
    }
}

module.exports = {
    sortKeys,
    stringify,
    parse,
    encodeText,
    decodeText,
    slugify,
    uniqueSlug,
    hash,
    writeFileAtomic,
    readFileOrNull,
    removeQuiet,
    pruneEmptyDirs,
};
