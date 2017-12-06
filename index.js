const co = require('co');
const merge = require('merge');
const Redis = require('ioredis');
const promisify = require('es6-promisify');
const config = require('./config');
const sha1 = require('./lib/sha1');
const needle = require('./lib/needle');
const wrapError = config.errorHandle || require('./lib/wrapError');
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
        return next(wrapError(error, { reason: errors.ERR_SESSION_CODE_NOT_EXIST }));
    }

    // 2、`rawData` not passed
    if (!rawData) {
        try {
            wxUserInfo = yield store.get(code);
            if(wxUserInfo) wxUserInfo = JSON.parse(wxUserInfo);
        } catch (error) {
            return next(error);
        }

        if (!wxUserInfo) {
            let error = new Error('`wxUserInfo` not found by `code`');
            return next(wrapError(error, { reason: errors.ERR_SESSION_EXPIRED }));
        }

        req.$wxUserInfo = wxUserInfo;
        return next();
    }

    // 3、both `code` and `rawData` passed

    try {
        rawData = decodeURIComponent(rawData);
        wxUserInfo = JSON.parse(rawData);
    } catch (error) {
        return next(wrapError(error));
    }

    if (config.ignoreSignature === true) {
        openId = ('PSEUDO_OPENID_' + sha1(wxUserInfo.avatarUrl)).slice(0, 28);
    } else {
        try {
            ({ sessionKey, openId } = yield jscode2session.exchange(code));
        } catch (error) {
            return next(wrapError(error, { reason: errors.ERR_SESSION_KEY_EXCHANGE_FAILED }));
        }

        // check signature
        if (sha1(rawData + sessionKey) !== signature) {
            let error = new Error('untrusted raw data');
            return next(wrapError(error, { reason: errors.ERR_UNTRUSTED_RAW_DATA }));
        }
    }

    try {
        wxUserInfo.openId = openId;

        let pc = new WXBizDataCrypt(config.appId, sessionKey);
        let encryptedUserInfo = pc.decryptData(encryptedData , iv);

        wxUserInfo = Object.assign(wxUserInfo, encryptedUserInfo);

        let data = {};
        data.user = {
            "userid": wxUserInfo.userId,
            "subscribe": wxUserInfo.subscribe,
            "mina_openid": wxUserInfo.openId,
            "nickname": wxUserInfo.nickName,
            "sex": wxUserInfo.sex,
            "language": wxUserInfo.language,
            "headimgurl": wxUserInfo.avatarUrl,
            "unionid": wxUserInfo.unionId
        }
        data.user.mina_openid = wxUserInfo.openId;
        data.user.openId = undefined;
        data.need_ppt_config = true;
        data.ip = req.ip;

        let resp = (yield needle.post(config.USERINFO_URL, data, {json: true, timeout: config.REQ_TIMEOUT}))[0];

        let body = resp.body;

        if(!body.UserID) {
            let error = new Error('get userinfo from django error');
            error.detail = body;
            throw error;
        }

        wxUserInfo.userId = body.UserID;
        
        wxUserInfo.profile_edit_status = body.profile_edit_status;
        wxUserInfo.nickName = body.Name || body.Nickname || wxUserInfo.nickName;
        wxUserInfo.School = body.School;
        wxUserInfo.Gender = body.Gender;
        wxUserInfo.YearOfBirth = body.YearOfBirth;
        wxUserInfo.avatarUrl = body.Avatar || wxUserInfo.avatarUrl;
        
        
        let oldCode = yield store.get(openId);
        oldCode && (yield store.del(oldCode));

        yield store.set(code, JSON.stringify(wxUserInfo), 'EX', config.redisConfig.ttl);
        yield store.set(openId, code, 'EX', config.redisConfig.ttl);

        req.$wxUserInfo = wxUserInfo;
        return next();

    } catch (error) {

        return next(error);
    }

});
module.exports = (options = {}) => {
    if (!store) {
        merge.recursive(config, options);
        let redisConfig = options.redisConfig || config.redisConfig; //todo: redis cluster

        store = options.store || new Redis.Cluster(redisConfig.startupNodes, redisConfig.redisOptions);
        return handler;
    }

    throw new Error('weapp-session can only be called once.');
};
