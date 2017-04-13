const co = require('co');
const merge = require('merge');
const promisify = require('es6-promisify');
const config = require('./config');
const sha1 = require('./lib/sha1');
const needle = require('./lib/needle');
const makeStore = require('./lib/makeStore');
const wrapError = require('./lib/wrapError');
const { headers, errors } = require('./constants');
const jscode2session = require('./lib/jscode2session');
const WXBizDataCrypt = require('./lib/WXBizDataCrypt');

let store;

const handler = co.wrap(function *(req, res, next) {
    req.$wxUserInfo = null;

    if (config.ignore(req, res)) {
        return next();
    }

    let code = String(req.header(headers.WX_CODE) || '');
    let rawData = String(req.header(headers.WX_RAW_DATA) || '');
    let signature = String(req.header(headers.WX_SIGNATURE) || '');
    let encryptedData = String(req.header(headers.WX_ENCRYPTED_DATA) || '');
    let iv = String(req.header(headers.WX_IV) || '');

    let wxUserInfo, sessionKey, openId;

    // 1、`code` not passed
    if (!code) {
        let error = new Error('not found `code`');
        return res.json(wrapError(error, { reason: errors.ERR_SESSION_CODE_NOT_EXIST }));
    }

    // 2、`rawData` not passed
    if (!rawData) {
        try {
            wxUserInfo = yield store.get(code);
        } catch (error) {
            return next(error);
        }

        if (!wxUserInfo) {
            let error = new Error('`wxUserInfo` not found by `code`');
            return res.json(wrapError(error, { reason: errors.ERR_SESSION_EXPIRED }));
        }

        req.$wxUserInfo = wxUserInfo;
        return next();
    }

    // 3、both `code` and `rawData` passed

    try {
        rawData = decodeURIComponent(rawData);
        wxUserInfo = JSON.parse(rawData);
    } catch (error) {
        return res.json(wrapError(error));
    }

    if (config.ignoreSignature === true) {
        openId = ('PSEUDO_OPENID_' + sha1(wxUserInfo.avatarUrl)).slice(0, 28);
    } else {
        try {
            ({ sessionKey, openId } = yield jscode2session.exchange(code));
        } catch (error) {
            return res.json(wrapError(error, { reason: errors.ERR_SESSION_KEY_EXCHANGE_FAILED }));
        }

        // check signature
        if (sha1(rawData + sessionKey) !== signature) {
            let error = new Error('untrusted raw data');
            return res.json(wrapError(error, { reason: errors.ERR_UNTRUSTED_RAW_DATA }));
        }
    }

    try {
        wxUserInfo.openId = openId;
        
        let pc = new WXBizDataCrypt(config.appId, sessionKey);
        let encryptedUserInfo = pc.decryptData(encryptedData , iv);
        wxUserInfo = Object.assign(wxUserInfo, encryptedUserInfo);

        let data = {unionid: wxUserInfo.unionId};
        let resp = (yield needle.post(config.DJANGO_USERINFO, data, {json: true, timeout: config.REQ_TIMEOUT}))[0];
        let body = resp.body;
        if(!body.userid) {
            let error = new Error('get userinfo from django error');
            error.detail = body;
            throw error;
        }

        wxUserInfo.userId = body.userid;

        let oldCode = yield store.get(openId);
        oldCode && (yield store.del(oldCode));

        yield store.set(code, wxUserInfo, config.redisConfig.ttl);
        yield store.set(openId, code, config.redisConfig.ttl);

        req.$wxUserInfo = wxUserInfo;
        return next();

    } catch (error) {
        return next(error);
    }

});

module.exports = (options = {}) => {
    if (!store) {
        merge.recursive(config, options);
        store = makeStore(config.redisConfig);
        return handler;
    }

    throw new Error('weapp-session can only be called once.');
};