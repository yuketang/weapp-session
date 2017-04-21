const co = require('co');
const Redis = require('ioredis');
const promisify = require('es6-promisify');

module.exports = (redisConfig = [], targetStore = {}) => {
    const client = new Redis.Cluster(redisConfig.startupNodes, redisConfig);
    const get = client.get.bind(client);
    const set = client.set.bind(client);
    const setex = client.setex.bind(client);
    const del = client.del.bind(client);

    return Object.assign(targetStore, {
        get: co.wrap(function *(key) {
            return JSON.parse(yield get(key));
        }),

        set: co.wrap(function *(key, val, lifetime = 0) {
            if (lifetime > 0) {
                yield setex(key, lifetime, JSON.stringify(val));
            } else {
                yield set(key, JSON.stringify(val));
            }
        }),

        del: co.wrap(function *(key) {
            yield del(key);
        }),
    });
};