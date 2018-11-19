// Constants
const IGNORE_ARG = '-';
const MIN_HEAP_SIZE = 10000;

// Utils
function str(p) {
    return Memory.readUtf8String(p);
}
function pmalloc() {
    return Memory.alloc(Process.pointerSize);
}
function debug() {
    send({ event: 'DEBUG', data: Array.prototype.slice.call(arguments).join(' ') });
}

// Globals
var Metadata = {}; // < className, { pointer, methods < methodName, { pointer, args[], returnType } >, fields } >
var Global = {}; // save global variables across hooks
var MonoApi = {};
