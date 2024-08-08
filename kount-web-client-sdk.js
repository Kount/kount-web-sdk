/* eslint-disable no-throw-literal */
export const KountSDKVersion = '2.1.0';

export default function kountSDK(config, sessionID) {

    const sdk = {

        implementationType: "module",
        repositoryLocation: "github",
        KountSDKVersion,
        kountClientID: null,
        isSinglePageApp: false,
        collectorURL: null,
        sessionID: null,
        kddcgid: null,
        FPCV_COOKIE_NAME: 'clientside-cookie',
        FPCV_LOCAL_STORAGE_KEY: 'clientside-local',
        FPCV_SESSION_STORAGE_KEY: 'kountCookie',
        SESSION_STORAGE_KEY_SESSION_ID: 'KountSessionID',
        collectBehaviorData: false,
        callbacks: {},
        error: [],
        isDebugEnabled: false,
        LOG_PREFIX: 'k:',
        serverConfig: null,
        orchestrateTimeoutId: null,
        updateSDKServerConfigTimeoutInMS: 3000,
        orchestrateSemaphoreLocked: false,

        start(config, sessionID) {

            if (typeof config === 'undefined') {
                if (window.console && window.console.log) {
                    console.log(`${this.LOG_PREFIX}SDK Disabled: config required.`);
                }
                return false;
            }

            this.isDebugEnabled = (typeof config.isDebugEnabled !== 'undefined') && (typeof config.isDebugEnabled === 'boolean') && config.isDebugEnabled;
            this.log(`SDK isDebugEnabled=${this.isDebugEnabled}`);

            this.log('SDK starting...');

            const configuredClientID = config.clientID;
            if ((typeof configuredClientID === 'undefined') || (configuredClientID.length === 0)) {
                this.log('SDK Disabled: clientID required.');
                return false;
            }
            this.kountClientID = configuredClientID;

            if ((typeof config.callbacks !== 'undefined')) {
                this.callbacks = config.callbacks;
            }

            const hostname = this._getHostname(config);
            if (hostname == null) {
                this.log(`SDK Disabled: unresolved hostname.`);
                return false;
            }

            this.collectorURL = `https://${hostname}`;
            this.log(`collectorURL=${this.collectorURL}`);

            const configuredIsSPA = config.isSinglePageApp;
            if ((typeof configuredIsSPA === 'undefined') || (configuredIsSPA !== true && configuredIsSPA !== false)) {
                this.log(`SDK Disabled: invalid isSinglePageApp:${configuredIsSPA}`);
                return false;
            }
            this.isSinglePageApp = configuredIsSPA;
            this.log(`isSinglePageApp=${this.isSinglePageApp}`);

            if ((typeof sessionID === 'undefined') || (sessionID.length === 0)) {
                this.log('SDK Disabled: sessionID required.');
                return false;
            }
            this.sessionID = sessionID;

            this.kddcgid = this._newKDDCGID();

            this._communicateLatestSessionData();

            this._orchestrate();

            this.log(`SDK Version=${this.KountSDKVersion}`);
            this.log(`SDK Implementation=${this.implementationType}`);
            this.log(`SDK Repository=${this.repositoryLocation}`);
            this.log('SDK started.');

            return true;
        },

        _orchestrate: async function (generateNewKDDCGID) {

            const functionName = "_orchestrate";

            let thisFunctionOwnsSemaphoreLock = false;

            try {

                if (this.orchestrateSemaphoreLocked) {
                    this.log(`${functionName} gated by semaphore. Skipping...`);
                    return;
                }

                this.orchestrateSemaphoreLocked = true;
                thisFunctionOwnsSemaphoreLock = true;

                this.log(`${functionName} start...`);

                if (generateNewKDDCGID) {
                    this.kddcgid = this._newKDDCGID();
                }

                this.serverConfig = await this._getServerConfig();

                if (this.serverConfig.collector.run) {
                    this.log(`${functionName} runCollector start...`);
                    this.runCollector();
                    this.log(`${functionName} runCollector end...`);
                } else {
                    this.log(`${functionName} runCollector skipped...`);
                    this.callback('collect-begin', { SessionID: this.sessionID, KountClientID: this.kountClientID });
                    this.callback('collect-end', { SessionID: this.sessionID, KountClientID: this.kountClientID });
                }

            } catch(e) {

                let msg = `${functionName} unexpected error: ${e}`;
                this.log(msg);
                this.addError(msg);

            } finally {

                if(!thisFunctionOwnsSemaphoreLock) {
                    return;
                }

                clearTimeout(this.orchestrateTimeoutId);

                this.log(`${functionName} config:${JSON.stringify(this.serverConfig)}`)

                let msUntilNextOrchestrate = this.serverConfig.ttlms;

                this.orchestrateTimeoutId = setTimeout(
                    this._orchestrate.bind(this, true),
                    msUntilNextOrchestrate
                );

                this.log(`${functionName} scheduled for ${msUntilNextOrchestrate} ms`);

                this.log(`${functionName} end...`);

                this.orchestrateSemaphoreLocked = false;

            }
        },

        _wrapPromiseInTimeout(msUntilTimeout, promise) {

            return new Promise((resolve, reject) => {

                const timer = setTimeout(() => {
                    reject(new Error(`Timeout after ${msUntilTimeout}ms.`));
                }, msUntilTimeout);

                promise
                    .then(value => {
                        clearTimeout(timer);
                        resolve(value);
                    })
                    .catch(reason=> {
                        clearTimeout(timer);
                        reject(reason);
                    })

            })

        },

        async _getServerConfig() {

            const functionName = "_getServerConfig";

            var serverConfig = null

            try {

                this.log(`${functionName} start...`);

                let url = this.buildUrl({
                        base:this.collectorURL,
                        path:"/cs/config",
                        parameters: {
                            m: this.kountClientID,
                            s: this.sessionID,
                            sv: this.KountSDKVersion,
                            kddcgid: this.kddcgid,
                            impl: this.implementationType,
                            repo: this.repositoryLocation
                        }});

                const response = await this._wrapPromiseInTimeout(this.updateSDKServerConfigTimeoutInMS, fetch(url));
                if (!response.ok) {
                    throw `response not ok: ${response.status}`;
                }

                const jsonConfig = await response.json();

                serverConfig = this._translateJSONToServerConfig(jsonConfig);

            } catch (e) {

                let msg = `${functionName} error caught. e:${e}`;
                this.log(msg);
                this.addError(msg);

            } finally {

                if (serverConfig == null) {
                    serverConfig = {
                        ttlms: 900000,
                        collector: {
                            run: true,
                            featureFlags: {
                                app: true,
                                battery: true,
                                browser: true,
                                exp: true,
                                page: true,
                                ui: true
                            }
                        }
                    }
                }

                this.log(`${functionName} config: ${JSON.stringify(serverConfig)}`);
                this.log(`${functionName} end...`);
                return serverConfig
            }

        },

        _translateJSONToServerConfig(jsonConfig) {
            let ttlms = this._translateTTLMSConfig(jsonConfig);

            let collectorConfig = this._translateCollectorConfig(jsonConfig)

            return {
                ttlms: ttlms,
                collector: collectorConfig,
            }
        },

        _translateTTLMSConfig(jsonConfig) {
            if (typeof jsonConfig.ttlms !== "number") {
                return 900000;
            }
            return jsonConfig.ttlms;
        },

        _translateCollectorConfig(jsonConfig) {

            const functionName = "_translateCollectorConfig";

            let collectorConfig = null

            try {

                this.log(`${functionName} start...`);

                if ((typeof jsonConfig.collection == 'undefined') || (typeof jsonConfig.collection.feature_flags == 'undefined')) {
                    throw `invalid response JSON:${JSON.stringify(jsonConfig)}`
                }

                if (typeof jsonConfig.collection.collect !== "boolean") {
                    throw `collect is not boolean: ${typeof collection.collect}`;
                }

                let runCollector = jsonConfig.collection.collect;
                if (runCollector) {

                    const feature_flags = jsonConfig.collection.feature_flags

                    if (typeof feature_flags.app !== "boolean") {
                        throw `app feature flag is not boolean: ${typeof feature_flags.app}`;
                    }
                    if (typeof feature_flags.battery !== "boolean") {
                        throw `battery feature flag is not boolean: ${typeof feature_flags.battery}`;
                    }
                    if (typeof feature_flags.browser !== "boolean") {
                        throw `browser feature flag is not boolean: ${typeof feature_flags.browser}`;
                    }
                    if (typeof feature_flags.exp !== "boolean") {
                        throw `exp feature flag is not boolean: ${typeof feature_flags.exp}`;
                    }
                    if (typeof feature_flags.page !== "boolean") {
                        throw `page feature flag is not boolean: ${typeof feature_flags.page}`;
                    }
                    if (typeof feature_flags.ui !== "boolean") {
                        throw `ui feature flag is not boolean: ${typeof feature_flags.ui}`;
                    }

                    collectorConfig = {
                        run: runCollector,
                        featureFlags: jsonConfig.collection.feature_flags
                    };

                } else {

                    collectorConfig = {
                        run: runCollector,
                    };

                }

            } catch (e) {

                let msg = `${functionName} error caught. e:${e}`;
                this.log(msg);
                this.addError(msg);

            } finally {

                if (collectorConfig == null) {
                    collectorConfig = {
                        run: true,
                        featureFlags: {
                            app: true,
                            battery: true,
                            browser: true,
                            exp: true,
                            page: true,
                            ui: true
                        }
                    }
                };

                this.log(`${functionName} end...`);
                return collectorConfig;
            }

        },

        _newKDDCGID() {
            let newKDDCGID = "invalid";

            try {
                if ((typeof crypto != 'undefined') && (typeof crypto.randomUUID != 'undefined')) {
                    newKDDCGID = crypto.randomUUID();
                } else {
                    const ALLOWED_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-1234567890";
                    let kddcgid = "";
                    for (let loopCount = 0; loopCount < 36; loopCount++) {
                        kddcgid += ALLOWED_CHARS.charAt(Math.floor(Math.random() * ALLOWED_CHARS.length));
                    }
                    newKDDCGID = kddcgid;
                }
            } catch (e) {
                this.log(`_newKDDCGID error:${e}`);
            } finally {
                this.log(`SDK kddcgid=${newKDDCGID}`);
            }

            return newKDDCGID;
        },

        _getHostname(config) {
            let configuredHostname = config.hostname;
            if (typeof configuredHostname !== 'undefined') {
                if (this._isHostnameValid(configuredHostname)) {
                    let configuredEnvironment = config.environment;
                    if (configuredEnvironment){
                        this.log(`warning:both 'environment':${configuredEnvironment} and deprecated 'hostname':${configuredHostname} configs were specified. using hostname.`);
                    }
                    return configuredHostname;
                }
                this.log(`invalid configuredHostname:${configuredHostname}`);
                return null;
            }

            let configuredEnvironment = config.environment;
            if (configuredEnvironment){
                configuredEnvironment = configuredEnvironment.toUpperCase();
            }
            switch (configuredEnvironment) {
                case 'TEST':
                    return "tst.kaptcha.com";
                case 'PROD':
                    return "ssl.kaptcha.com";
                default:
                    this.log(`invalid configuredEnvironment:${configuredEnvironment}`);
                    return null;
            };
        },

        _isHostnameValid(hostname) {
            if (typeof hostname !== 'string') {
                this.log(`Invalid hostname: not a string: ${typeof hostname}`);
                return false;
            }
            if (hostname.length === 0) {
                this.log('Invalid hostname: length 0.');
                return false;
            }
            const regex = /^[a-zA-Z0-9.]*$/g;
            if (!regex.test(hostname)) {
                this.log(`Invalid hostname:${hostname}`);
                return false;
            }
            return true;
        },

        _communicateLatestSessionData() {
            try {
                this.log('communicateLatestSessionData running...');
                const sessionIdInSessionStorage = sessionStorage.getItem(this.SESSION_STORAGE_KEY_SESSION_ID);
                if (sessionIdInSessionStorage === null) {
                    this.postNewSession(this.sessionID);
                } else if (sessionIdInSessionStorage !== this.sessionID) {
                    this.postChangeSession(this.sessionID, sessionIdInSessionStorage);
                }

                sessionStorage.setItem(this.SESSION_STORAGE_KEY_SESSION_ID, this.sessionID);
            } catch (e) {
                this.addError(`communicateLatestSessionData error:${e}`);
            } finally {
                this.log('communicateLatestSessionData ending...');
            }
        },

        async postNewSession(sessionID) {
            try {
                this.log('postNewSession running...');
                let response = await fetch(
                    this.buildUrl({
                        base: this.collectorURL,
                        path: `/session/${sessionID}`,
                        parameters: {
                            kddcgid: this.kddcgid,
                            impl:this.implementationType,
                            repo: this.repositoryLocation,
                        }
                    }), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'client-id': this.kountClientID

                    },
                });
                if (response.status === 200 || response.status === 201) {
                    this.log('postNewSession success');
                } else {
                    this.addError(`postNewSession unknown response: ${response.status}`);
                }
            } catch (e) {
                this.addError(`postNewSession error:${e}`);
            } finally {
                this.log('postNewSession ending...');
            }
        },

        async postChangeSession(sessionID, previousSessionID) {
            try {
                this.log(`postChangeSession running: newSession: ${sessionID} prevSession: ${previousSessionID}`);
                let response = await fetch(
                    this.buildUrl({
                        base: this.collectorURL,
                        path: `/session/${sessionID}`,
                        parameters: {
                            previousSessionID: previousSessionID,
                            kddcgid: this.kddcgid,
                            impl:this.implementationType,
                            repo: this.repositoryLocation,
                        }
                    }), {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'client-id': this.kountClientID

                    },
                });
                if (response.status === 200 || response.status === 201) {
                    this.log('postChangeSession success');
                } else {
                    this.addError(`postChangeSession unknown response: ${response.status}`);
                }
            } catch (e) {
                this.addError(`postChangeSession error:${e}`);
            } finally {
                this.log('postChangeSession ending...');
            }
        },

        getFPCVFromLocalStorage() {
            try {
                this.log('getFPCVFromLocalStorage running...');
                const value = localStorage.getItem(this.FPCV_LOCAL_STORAGE_KEY);

                if (value == null) {
                    return '';
                }
                return value;
            } catch (e) {
                this.addError(`getFPCVFromLocalStorage: error${e}`);
                return '';
            }
        },

        getFPCVFromCookie() {
            try {
                this.log('getFPCVFromCookie running...');
                const dc = decodeURIComponent(document.cookie);
                const cookieList = dc.split(';');
                let cookieValue = '';

                for (let i = 0; i < cookieList.length; i++) {
                    const currentCookie = cookieList[i].trim();
                    const elements = currentCookie.split('=');
                    if (elements.length === 2) {
                        if (elements[0] === this.FPCV_COOKIE_NAME) {
                            [, cookieValue] = elements;
                            this.log(`getFPCVFromCookie: found new first party cookie: ${cookieValue}`);
                            break;
                        }
                    }
                }

                if (cookieValue === '') {
                    const regex = /(cdn[.][a-z]+[.][0-9]+[.]ka.ck)/g;
                    for (let i = 0; i < cookieList.length; i++) {
                        const currentCookie = cookieList[i].trim();
                        if (regex.test(currentCookie) === true) {
                            const elements = currentCookie.split('=');
                            if (elements.length === 2) {
                                [, cookieValue] = elements;
                                this.log(`getFPCVFromCookie: found old first party cookie: ${cookieValue}`);
                                this.storeFPCVInCookie(cookieValue);
                                break;
                            }
                        }
                    }
                }

                return cookieValue;
            } catch (e) {
                this.addError(`getFPCVFromCookie error:${e}`);
                return '';
            }
        },

        storeFPCVInLocalStore(value) {
            try {
                this.log('storeFPCVInLocalStore running...');
                localStorage.setItem(this.FPCV_LOCAL_STORAGE_KEY, value);
            } catch (e) {
                this.addError(`storeFPCVInLocalStore error:${e}`);
            } finally {
                this.log('storeFPCVInLocalStore ending...');
            }
        },

        storeFPCVInCookie(value) {
            try {
                this.log('storeFPCVInCookie running...');
                const expire = 365;
                const d = new Date();
                d.setTime(d.getTime() + (expire * 24 * 60 * 60 * 1000));
                const expires = `expires=${d.toUTCString()}`;

                let attributes = '; SameSite=None; Secure';
                if (window.location.protocol !== 'https:') {
                    attributes = '; SameSite=Lax';
                }
                document.cookie = `${this.FPCV_COOKIE_NAME}=${value};${expires};path=/${attributes}`;
            } catch (e) {
                this.addError(`storeFPCVInCookie error:${e}`);
            } finally {
                this.log('storeFPCVInCookie ending...');
            }
        },

        storeFPCVInSession(value) {
            try {
                this.log('storeFPCVInSession running...');
                sessionStorage.setItem(sdk.FPCV_SESSION_STORAGE_KEY, value);
            } catch (e) {
                this.addError(`storeFPCVInSession error:${e}`);
            }
        },

        coordinateFirstPartyCookieValues() {
            this.log('coordinateFirstPartyCookieValues running...');
            let deducedFPCV = '';
            const fpcvFromCookie = this.getFPCVFromCookie();
            const fpcvFromLocalStorage = this.getFPCVFromLocalStorage();

            this.storeFPCVInSession('');

            if ((fpcvFromCookie === '') && (fpcvFromLocalStorage === '')) {
                deducedFPCV = '';
            } else if ((fpcvFromCookie !== '') && (fpcvFromLocalStorage === '')) {
                this.storeFPCVInLocalStore(fpcvFromCookie);
                deducedFPCV = fpcvFromCookie;
            } else if ((fpcvFromLocalStorage !== '') && (fpcvFromCookie === '')) {
                this.storeFPCVInCookie(fpcvFromLocalStorage);
                deducedFPCV = fpcvFromLocalStorage;
            } else if ((fpcvFromLocalStorage === fpcvFromCookie) && (fpcvFromLocalStorage !== '') && (fpcvFromCookie !== '')) {
                deducedFPCV = fpcvFromLocalStorage;
            } else if ((fpcvFromLocalStorage !== fpcvFromCookie) && (fpcvFromLocalStorage !== '') && (fpcvFromCookie !== '')) {
                this.storeFPCVInCookie(fpcvFromLocalStorage);
                deducedFPCV = fpcvFromLocalStorage;
            }

            if (deducedFPCV === '') {
                this.establishNewFPCV();
            } else {
                this.communicateExistingFPCV(deducedFPCV);
            }
        },

        async establishNewFPCV() {
            try {
                this.log('establishNewFPCV running...');
                let url = this.buildUrl({
                        base:this.collectorURL,
                        path:"/cs/generatecookie",
                        parameters: {
                            m: this.kountClientID,
                            s: this.sessionID,
                            sv: this.KountSDKVersion,
                            kddcgid: this.kddcgid,
                            impl: this.implementationType,
                            repo: this.repositoryLocation
                        }});
                const response = await fetch(url);
                const json = await response.json();
                if (json.value.length > 0) {
                    let firstPartyCookieValue = json.value;
                    this.storeFPCVInCookie(firstPartyCookieValue);
                    this.storeFPCVInLocalStore(firstPartyCookieValue);
                    this.storeFPCVInSession(firstPartyCookieValue);
                }
            } catch (e) {
                this.addError(`establishNewFPCV error:${e}`);
            } finally {
                this.log('establishNewFPCV ending...');
            }
        },

        async communicateExistingFPCV(value) {
            try {
                this.log('communicateExistingFPCV running...');

                let response = await fetch(
                    this.buildUrl({
                        base:this.collectorURL,
                        path:'/cs/storecookie'
                    }), {
                    method: 'POST',
                    body: this.buildParams({
                            m: this.kountClientID,
                            s: this.sessionID,
                            sv: this.KountSDKVersion,
                            k: value,
                            kddcgid: this.kddcgid,
                            impl: this.implementationType,
                            repo: this.repositoryLocation
                        }),
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded"
                    },
                });

                if (response.status === 500) {
                    this.log('communicateExistingFPCV: invalid cookie');
                    sdk.establishNewFPCV();
                }

                if (response.status === 200) {
                    this.log('communicateExistingFPCV: valid cookie');
                    sdk.storeFPCVInSession(value);
                }
            } catch (e) {
                this.addError(`communicateExistingFPCV error:${e}`);
            }
        },

        _createIframe() {

            const functionName = "_createIframe";

            try {

                this.log(`${functionName} running...`);

                const iframeId = 'ibody';
                const priorIframe = document.getElementById(iframeId);
                if (priorIframe !== null) {
                    priorIframe.remove();
                }

                let url = this.buildUrl({
                    base:this.collectorURL,
                    path:`/logo.htm`,
                    parameters:{
                        m: this.kountClientID,
                        s: this.sessionID,
                        sv: this.KountSDKVersion,
                        kddcgid: this.kddcgid,
                        impl: this.implementationType,
                        repo: this.repositoryLocation,
                    },
                });

                if (this.isDebugEnabled) {
                    url.hash = '#console';
                }


                const iframe = document.createElement('iframe');
                iframe.id = iframeId;
                iframe.style.border = '0px';
                iframe.style.height = '1px';
                iframe.style.width = '1px';
                iframe.style.position = 'absolute';
                iframe.src = url.toString();
                document.getElementsByTagName('body')[0].appendChild(iframe);

                if (typeof this.callbacks !== 'undefined') {
                    this.callback('collect-begin', { SessionID: this.sessionID, KountClientID: this.kountClientID });
                }

                if (window.postMessage !== 'undefined' && window.onmessage !== 'undefined') {
                    let onMessageHandlerFunc = (event) => {
                        try {
                            if (event.origin !== this.collectorURL) {
                                this.log(`window.onmessage doesn't handle event origin:[type:${event.type}, origin:${event.origin}]`);
                                return;
                            }

                            if (!event.data) {
                                throw new Error(`window.onmessage event has missing event.data:[type:${event.type}, origin:${event.origin}]`);
                            }

                            let data = null;
                            if (JSON) {
                                data = JSON.parse(event.data);
                            } else {
                                data = eval(event.data);
                            }

                            if (!this.isSinglePageApp && data.event === 'collect-end') {
                                this.detach(window, 'unload', this.unloadHandler);
                            }

                            if (!data) {
                                throw new Error(`window.onmessage event has missing data:[type:${event.type}, origin:${event.origin}]`);
                            }

                            if (!data.params) {
                                throw new Error(`window.onmessage event has missing data.params:[type:${event.type}, origin:${event.origin}, data:${event.data}]`);
                            }

                            const params = {};

                            Object.keys(data.params).forEach((index) => {
                                if (Object.prototype.hasOwnProperty.call(data.params, index)) {
                                    switch (index) {
                                    case 's':
                                        params.SessionID = data.params[index];
                                        break;
                                    case 'm':
                                        params.KountClientID = data.params[index];
                                        break;
                                    default:
                                        params[index] = data.params[index];
                                    }
                                }
                            });

                            this.callback(data.event, params);

                            this.log(`window.onmessage executed for event:[type:${event.type}, origin:${event.origin}, data:${event.data}]`);

                        } catch (e) {
                            this.log(`window.onmessage encountered an error: ${e}`);
                        }
                    };

                    window.onmessage = onMessageHandlerFunc;

                    if (!this.isSinglePageApp) {
                        this.attach(window, 'unload', this.unloadHandler);
                    }
                } else {
                    window.setTimeout(() => {
                        this.callback('collect-end', { SessionID: this.sessionID, KountClientID: this.kountClientID });
                    }, 3000);
                }
            } catch (e) {
                this.addError(`${functionName} error:${e}`);
            } finally {
                this.log(`${functionName} ending...`);
            }
        },

        runCollector() {

            const functionName = "runCollector";

            try {

                this.log(`${functionName} running...`);

                this.coordinateFirstPartyCookieValues();

                const waitForFirstParty = (timeoutInMS, intervalBetweenChecksInMS) => new Promise((resolve, reject) => {
                    const checkForFirstParty = () => {
                        if (sessionStorage.getItem(this.FPCV_SESSION_STORAGE_KEY) !== '') {
                            this._createIframe();
                            resolve();
                        } else if ((timeoutInMS -= intervalBetweenChecksInMS) < 0) {
                            reject();
                        } else {
                            setTimeout(checkForFirstParty, intervalBetweenChecksInMS);
                        }
                    };
                    setTimeout(checkForFirstParty, intervalBetweenChecksInMS);
                });

                (async () => {
                    waitForFirstParty(2000, 10)
                        .then(() => this.log(`${functionName}: Collection Initiated`))
                        .catch(() => this.log(`${functionName}: Invalid/Missing First Party cookie`));
                })();

            } catch (e) {
                this.addError(`${functionName} error:${e}`);
            } finally {
                this.log(`${functionName} ending...`);
            }
        },

        AttachToForm(formID, options = new Map()) {
            this.log('AttachToForm running...');
            let decisionPointField = 'kountDecisionPointUUID';
            if (this.collectBehaviorData) {
            }

            this.log('AttachToForm: Attaching to form...');
            const form = document.getElementById(formID);

            if (options != null && options.has('CustomFieldName') && options.get('CustomFieldName').length > 0) {
                this.log(`AttachToForm: Overriding decisionPointField name to: ${options.get('CustomFieldName')}`);
                decisionPointField = options.get('CustomFieldName');
            }

            if (form != null) {
                if (typeof form[decisionPointField] === 'undefined') {
                    const hiddenField = document.createElement('input');
                    hiddenField.setAttribute('type', 'hidden');
                    hiddenField.setAttribute('name', decisionPointField);
                    hiddenField.setAttribute('value', this.sessionID);
                    form.appendChild(hiddenField);
                    this.log(`AttachToForm: Field ${decisionPointField} NOT found. \
                    Created and attached to form with value: ${this.sessionID}`);
                } else {
                    this.log(`AttachToForm: Field ${decisionPointField} found, setting value to: ${this.sessionID}`);
                    form[decisionPointField].setAttribute('value', this.sessionID);
                }

                this.log(`AttachToForm: Attached to form successfully using ${this.sessionID} \
                value in ${decisionPointField} hidden field.`);
            } else {
                this.addError(`AttachToForm: FormID: ${formID} is not valid. Skipping attachment to form and collection.`);
            }
        },

        NewSession(sessionID) {
            if (typeof sessionID === 'undefined') {
                this.addError("NewSession: Invalid sessionID.  You must set the 'sessionID' for collection. Disabling Kount SDK");
            } else {
                this.log(`NewSession: SessionID set to: ${sessionID}`);
                sessionStorage.clear();
                this.sessionID = sessionID;
                this._communicateLatestSessionData();
                this._orchestrate(true);
            }
        },

        log(message) {
            if (this.isDebugEnabled && window.console && window.console.debug) {
                console.debug(`${this.LOG_PREFIX}${message}`);
            }
        },

        addError(error) {
            this.error.push(error);
            this.log(error);
        },

        callback(event, params) {
            if (typeof this.callbacks[event] !== 'undefined') {
                const theCallback = this.callbacks[event];
                this.callbacks[event] = undefined;
                theCallback(params);
            }
        },

        unloadHandler(event) {
            const endpoint = 'fin';
            const formData = {
                n: 'collect-end', com: 'false', et: 0, s: this.sessionID, m: this.kountClientID,
            };
            try {
                const http = this.getXMLHttpRequest(endpoint, 'POST');
                http.send(formData);
            } catch (e) {}
        },

        getXMLHttpRequest(endpoint, method) {
            let http = null;
            const esc = encodeURIComponent || escape;
            const url = `${this.collectorURL}/${endpoint}`;
            if (window.XMLHttpRequest) {
                try {
                    http = new window.XMLHttpRequest();
                } catch (e) {}
                if ('withCredentials' in http) {
                    http.open(method, url, false);
                } else if (typeof window.XDomainRequest !== 'undefined') {
                    http = new window.XDomainRequest();
                    http.open(method, url);
                } else {
                    http = null;
                }
            } else {
                http = null;
            }
            return {
                send(data) {
                    if (!http) {
                        return;
                    }
                    http.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
                    let payload = '';

                    Object.keys(data).forEach((key) => {
                        if (Object.prototype.hasOwnProperty.call(data, key)) {
                            payload += `&${esc(key)}=${esc(data[key])}`;
                        }
                    });

                    payload = payload.substring(1);
                    http.send(payload);
                },
            };
        },

        buildUrl({base, path, parameters = {}}) {
            let params = this.buildParams(parameters);
            path = [...params].length == 0 ? path : path + "?" + params.toString();
            let url = new URL(path, base);
            return url;
        },

        buildParams(parameters = {}) {
            let searchParams = new URLSearchParams();
            for (const [key, value] of Object.entries(parameters)) {
                searchParams.append(key, value);
            }
            return searchParams;
        },

        attach: (function attachFunc() {
            if (typeof document.addEventListener !== 'undefined') {
                return function addEventListenerFunc(element, event, callback) {
                    element.addEventListener(event, callback, false);
                };
            } if (typeof document.attachEvent !== 'undefined') {
                return function attachEventFunc(element, event, callback) {
                    element.attachEvent(`on${event}`, callback);
                };
            }
            return function noOpFunc(element, event, callback) {};
        }()),

        detach: (function detachFunc() {
            if (typeof document.removeEventListener !== 'undefined') {
                return function removeEventListenerFunc(element, event, listener) {
                    element.removeEventListener(event, listener, false);
                };
            } if (typeof document.detachEvent !== 'undefined') {
                return function detachEventFunc(element, event, listener) {
                    element.detach(`on${event}`, listener);
                };
            }
            return function noOpFunc(element, event, listener) {};
        }()),

    };

    try {
        if (sdk.start(config, sessionID)) {
            return sdk;
        }
    } catch (e) {
    }
    return null;
}
