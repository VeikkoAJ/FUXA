'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');

let writes = [];

function FakeAdsClient() {
    this.connection = { connected: false };
}
FakeAdsClient.prototype.connect = async function () {
    this.connection.connected = true;
    return { targetAmsNetId: '127.0.0.1' };
};
FakeAdsClient.prototype.on = function () { };
FakeAdsClient.prototype.getSymbols = async function () {
    return {};
};
FakeAdsClient.prototype.subscribeValue = async function () { };
FakeAdsClient.prototype.unsubscribeAll = async function () { };
FakeAdsClient.prototype.disconnect = function () { };
FakeAdsClient.prototype.writeValue = async function (address, value) {
    writes.push({ address, value });
};

describe('ADS write scaling', function () {
    let originalLoad;

    before(function () {
        originalLoad = Module._load;
        Module._load = function (request) {
            if (request === 'ads-client') {
                return { Client: FakeAdsClient };
            }
            return originalLoad.apply(this, arguments);
        };
        delete require.cache[require.resolve('../../runtime/devices/adsclient')];
    });

    after(function () {
        Module._load = originalLoad;
        delete require.cache[require.resolve('../../runtime/devices/adsclient')];
    });

    async function written(tag, value) {
        const driver = require('../../runtime/devices/adsclient');
        const client = driver.create({
            id: 'ads-device-1',
            name: 'ADS test',
            enabled: true,
            property: { address: '192.168.0.1:851' },
            tags: { tag1: Object.assign({ id: 'tag1', name: 'Tag 1', address: 'MAIN.value' }, tag) }
        }, { info() { }, warn() { }, error() { } }, new EventEmitter(), null, {});
        await client.connect();
        writes = [];
        await client.setValue('tag1', value);
        assert.strictEqual(writes.length, 1);
        assert.strictEqual(writes[0].address, 'MAIN.value');
        return writes[0].value;
    }

    it('applies the write expression to number tags without losing decimals', async function () {
        const tag = { type: 'number', scale: { mode: 'expression', readExpression: 'x', writeExpression: 'this * 1000' } };
        assert.strictEqual(await written(tag, '61.850'), 61850);
        assert.strictEqual(await written(tag, 61.7), 61700);
    });

    it('applies linear scaling to number tags', async function () {
        const tag = { type: 'number', scale: { mode: 'linear', rawLow: 0, rawHigh: 10000, scaledLow: 0, scaledHigh: 10 } };
        assert.strictEqual(await written(tag, '2.5'), 2500);
    });

    it('writes unscaled number tags as floats', async function () {
        assert.strictEqual(await written({ type: 'number' }, '61.7'), 61.7);
    });

    it('converts boolean string values', async function () {
        assert.strictEqual(await written({ type: 'boolean' }, 'true'), 1);
        assert.strictEqual(await written({ type: 'boolean' }, 'false'), 0);
        assert.strictEqual(await written({ type: 'boolean' }, '1'), 1);
    });

    it('writes string tags unchanged', async function () {
        assert.strictEqual(await written({ type: 'string' }, 'abc'), 'abc');
    });
});
