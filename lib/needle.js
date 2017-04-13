'use strict';

var needle = require('needle');
var pify = require('pify');

needle.promisify = function promisify(_Promise) {
    if (!_Promise) {
        if (typeof Promise !== 'undefined') {
            _Promise = Promise;
        } else {
            return needle;
        }
    }

    return pify(needle, _Promise, {
        multiArgs: true,
        include: ['head', 'get', 'post', 'put', 'patch', 'delete', 'request']
    });
};

module.exports = needle.promisify();