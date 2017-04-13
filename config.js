module.exports = {
    appId: '',
    appSecret: '',

    redisConfig: {
        startupNodes: [],
        password: '',
        db: 0,
        prefix: 'weapp-session:',
        detect_buffers: true,
        ttl: 7200,
    },

    ignoreSignature: false,
    ignore: () => false,

    USERINFO_URL: '',
    REQ_TIMEOUT: 3000
};