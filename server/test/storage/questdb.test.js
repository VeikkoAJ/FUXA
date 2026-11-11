const assert = require('node:assert/strict');
const Module = require('module');

describe('QuestDB UNS paths', () => {
    let storage;
    let rows;
    let flushed;
    let errors;

    beforeEach(() => {
        rows = [];
        errors = [];
        let resolveFlush;
        flushed = new Promise(resolve => { resolveFlush = resolve; });
        let row;
        const sender = {
            table(name) { row = { table: name }; return this; },
            symbol(name, value) { row[name] = value; return this; },
            stringColumn(name, value) { row[name] = value; return this; },
            floatColumn(name, value) { row[name] = value; return this; },
            async at(timestamp, unit) { rows.push({ ...row, timestamp, unit }); },
            async flush() { resolveFlush(); },
            async close() {},
        };
        const originalLoad = Module._load;
        const path = require.resolve('../../runtime/storage/questdb');
        delete require.cache[path];
        Module._load = function (request) {
            if (request === 'pg') {
                return { Pool: class { async query() { return { rows: [] }; } async end() {} } };
            }
            if (request === '@questdb/nodejs-client') {
                return { Sender: { async fromConfig() { return sender; } } };
            }
            return originalLoad.apply(this, arguments);
        };
        try {
            storage = require(path).create({ daqstore: {} }, {
                info() {}, warn() {}, error(message) { errors.push(message); },
            });
        } finally {
            Module._load = originalLoad;
            delete require.cache[path];
        }
    });

    afterEach(() => storage.close());

    const cases = [
        ['nested device path', { tagref: { unsPath: ' Floor/Meter/Power ' } }, 'Floor/Meter/Power'],
        ['direct script path', { unsPath: 'Script/Power' }, 'Script/Power'],
        ['direct path takes precedence', { unsPath: 'Direct', tagref: { unsPath: 'Nested' } }, 'Direct'],
        ['explicit empty path', { unsPath: '', tagref: { unsPath: 'Nested' } }, undefined],
        ['explicit null path', { unsPath: null, tagref: { unsPath: 'Nested' } }, undefined],
        ['missing path', {}, undefined],
        ['null tag reference', { tagref: null }, undefined],
        ['blank nested path', { tagref: { unsPath: '   ' } }, undefined],
    ];

    for (const [name, metadata, expected] of cases) {
        it(name, async () => {
            const tag = { id: 'power', value: 42, timestamp: 1234, daq: { enabled: true }, ...metadata };
            const before = JSON.stringify(tag);
            storage.addDaqValues({ power: tag }, 'Meter', 'device-1');
            await flushed;
            assert.deepEqual(errors, []);
            assert.equal(rows.length, 1);
            assert.equal(rows[0].uns_path, expected);
            assert.equal(rows[0].tag_id, 'power');
            assert.equal(rows[0].device_id, 'device-1');
            assert.equal(rows[0].device_name, 'Meter');
            assert.equal(rows[0].number_value, 42);
            assert.equal(rows[0].timestamp, 1234);
            assert.equal(rows[0].unit, 'ms');
            assert.equal(JSON.stringify(tag), before);
        });
    }
});

describe('QuestDB history timestamps', () => {
    const realTypes = require('pg').types;
    let originalTz;
    let poolConfigs;

    before(() => {
        originalTz = process.env.TZ;
        // A non-UTC server zone exposes local-time parsing of QuestDB timestamps.
        process.env.TZ = 'Europe/Helsinki';
    });

    after(() => {
        if (originalTz === undefined) {
            delete process.env.TZ;
        } else {
            process.env.TZ = originalTz;
        }
    });

    function createStorage(onQuery = () => ({ rows: [] })) {
        poolConfigs = [];
        const originalLoad = Module._load;
        const path = require.resolve('../../runtime/storage/questdb');
        delete require.cache[path];
        Module._load = function (request) {
            if (request === 'pg') {
                return {
                    types: realTypes,
                    Pool: class {
                        constructor(config) { this.config = config; poolConfigs.push(config); }
                        async query(text, params) { return onQuery(this.config, text, params); }
                        async end() {}
                    },
                };
            }
            if (request === '@questdb/nodejs-client') {
                return { Sender: { async fromConfig() { return { async close() {} }; } } };
            }
            return originalLoad.apply(this, arguments);
        };
        try {
            return require(path).create({ daqstore: {} }, { info() {}, warn() {}, error() {} });
        } finally {
            Module._load = originalLoad;
            delete require.cache[path];
        }
    }

    it('reads QuestDB UTC timestamps without a local-time shift', async () => {
        assert.equal(new Date(Date.UTC(2026, 10, 11)).getTimezoneOffset(), -120);
        const stored = Date.UTC(2026, 10, 11, 10, 0, 0, 123);
        let selectParams;
        const storage = createStorage((config, text, params) => {
            if (!/^\s*SELECT/.test(text)) {
                return { rows: [] };
            }
            selectParams = params;
            // QuestDB sends TIMESTAMP as OID 1114 text without a zone designator;
            // like pg, use its default parsers when the pool sets no types.
            const parse = (config.types || realTypes).getTypeParser(1114, 'text');
            return { rows: [
                { timestamp: parse('2026-11-11 10:00:00.123456'), number_value: 42, string_value: null },
                { timestamp: parse('2026-11-11 10:00:01'), number_value: null, string_value: 'on' },
            ] };
        });
        try {
            const rows = await storage.getDaqValue('power', stored - 3600e3, stored + 3600e3);
            assert.deepEqual(rows, [
                { dt: stored, value: 42 },
                { dt: Date.UTC(2026, 10, 11, 10, 0, 1), value: 'on' },
            ]);
            assert.deepEqual(selectParams, ['power', '2026-11-11T09:00:00.123Z', '2026-11-11T11:00:00.123Z']);
        } finally {
            storage.close();
        }
    });

    it('keeps the default parsers for other column types', () => {
        createStorage().close();
        assert.equal(poolConfigs.length, 1);
        const { types } = poolConfigs[0];
        assert.equal(types.getTypeParser(20, 'text'), realTypes.getTypeParser(20, 'text'));
        assert.equal(types.getTypeParser(1114, 'binary'), realTypes.getTypeParser(1114, 'binary'));
    });
});
