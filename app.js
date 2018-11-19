#!/usr/bin/env node

const fs = require('fs');
const fse = require('fs-extra');
const frida = require('frida');

if (process.argv.length <= 2) {
    console.log(`Usage: .${__filename} <app identifier> --debug`);
    process.exit(-1);
}

let APP_ID = process.argv[2];
const APP_DIR = __dirname + '/__handlers__/' + APP_ID + '/';
const DEBUG = true;

function exclude(obj, keys) {
    return Object.keys(obj)
        .filter(k => !keys.includes(k))
        .map(k => Object.assign({}, {[k]: obj[k]}))
        .reduce((res, o) => Object.assign(res, o), {});
}

// TODO extract as module ( db = require('fs-simple-json-db') )
const db = {
    ext: '.json',
    cache: {},
    init: function (path) {
        this.path = path;
        const extLength = this.ext.length;
        fs.readdir(this.path, (err, files) => {
            if (err) {
                console.error(err);
            } else {
                files.forEach(fileName => {
                    let fileFullPath = this.path + fileName;
                    fse.readJson(fileFullPath)
                        .then(fileContent => {
                            this.cache[fileName.substring(0, fileName.length - extLength)] = fileContent;
                        })
                        .catch(console.error);
                });
            }
        });
    },
    fp: function (fname) { // get file path
        return this.path + fname + this.ext;
    },
    put: function (payload) {
        const fname = payload[payload['index']];
        const data = exclude(payload, ['event', 'index'/*, payload['index']*/]);
        this.cache[fname] = data;
        fse.outputJsonSync(this.fp(fname), data);
        console.log(`[PUT] [ ${fname} ] [ ${data} ]`);
    },
    get: function (payload) {
        let fname = payload[Object.keys(payload).filter(key => key !== 'event')[0]];
        if (this.cache[fname]) {
            console.log(`[GET] [CACHED] [ ${this.cache[fname]} ]`);
        } else {
            let filePath = this.fp(fname);
            let content = fse.readJSONSync(filePath, { throws: false });
            console.log(`[GET] [ ${filePath} ] [ ${content} ]`);
            this.cache[fname] = content;
        }
    }
};

const source = fs.readFileSync('./engine.js').toString()
    .replace('/*placeholder*/', fs.readFileSync(APP_DIR + 'inject.js'));

const EventHandlers = {
    DEBUG: (payload) => {
        if (DEBUG)
            console.log(`[D] ${payload['data']}`);
    },
    // LOG: (payload) => console.log(`[+] ${payload['data']}`),
    METADATA: (payload) => {
        let metadataFilePath = APP_DIR + 'metadata.json';
        fse.writeJson(metadataFilePath, payload['data'])
            .then(() =>  console.log(`[*] Saved metadata @ [ ${metadataFilePath} ]`))
            .catch(err => console.error('[!] Error occurred while writing metadata;\n', err));
    },
    GET: (payload) =>  db.get(payload),
    PUT: (payload) => db.put(payload)
};

let device, pid, session, script;

function stop() { // cleanup, TODO add session.detach ?
    if (script !== null) {
        script.unload().then(() => {
            script = null;
            console.log('[!] Script unloaded');
        }).catch(console.error);
    }
}

async function Main() {
    db.init(APP_DIR + 'db/');

    device = await frida.getUsbDevice();
    pid = await device.spawn([APP_ID]);
    session = await device.attach(pid);
    script = await session.createScript(source);

    script.message.connect(msg => {
        if (msg['type'] === 'send') {
            let payload = msg['payload'];
            let event = payload['event'];
            if (event in EventHandlers)
                EventHandlers[event](payload);
            else
                console.warn(`[!] Unhandled event [ ${event} ]`);
        } else {
            console.error('[!!]', msg, '\n', msg['stack']);
        }
    });

    await script.load();
    await device.resume(pid);

    process.stdin.resume(); // keep process running
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    console.log('...');
}

Main().catch(console.error);
