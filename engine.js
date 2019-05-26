// Constants
const kIgnoreArg = '-';

// Utils
function pmalloc() {
    return Memory.alloc(Process.pointerSize);
}
function debug() {
    send({ event: 'DEBUG', data: Array.prototype.slice.call(arguments).join(' ') });
}

// Globals
var Metadata = {}; // < className, { pointer, methods < methodName, { pointer, args[], returnType } >, fields } >
var Global = {}; // save global variables across hooks
var MonoApi = {
    mono_image_get_table_rows: ['int', ['MonoImage*', 'int'/*table_id*/]],
    mono_class_get: ['MonoClass*', ['MonoImage*', 'int'/*type_token*/]],
    mono_class_get_parent: ['MonoClass*', ['MonoClass*']],
    mono_class_get_name: ['char*', ['MonoClass*']],
    mono_method_get_name: ['char*', ['MonoMethod*']],
    mono_class_get_methods: ['MonoMethod*', ['MonoClass*', 'iter*']],
    mono_class_get_fields: ['MonoClassField*', ['MonoClass*', 'iter*']],
    mono_signature_get_params: ['MonoType*', ['MonoMethod*', 'iter*']],
    mono_field_full_name: ['char*', ['MonoField*']],
    mono_class_get_namespace: ['char*', ['MonoClass*']],
    mono_type_full_name: ['char*', ['MonoType*']],
    mono_signature_get_return_type: ['MonoType*', ['MonoMethodSignature*']],
    mono_class_get_method_from_name: ['MonoMethod*', ['MonoClass*', 'name*', 'int'/*number of params. -1 for any*/]],
    mono_method_signature: ['MonoMethodSignature*', ['MonoMethod*']],
    /** gpointer mono_compile_method (MonoMethod *method)
     * http://docs.go-mono.com/index.aspx?link=xhtml%3Adeploy%2Fmono-api-unsorted.html */
    mono_compile_method: ['gpointer*'/* pointer to the native code produced.*/, ['MonoMethod*']],
    /**
     * char* mono_string_to_utf8 (MonoString *s)
     * @param    s	a System.String
     * @Description
     # TODO mono_free
     *       Returns the UTF8 representation for s. The resulting buffer needs to be freed with mono_free().
     *       deprecated Use mono_string_to_utf8_checked to avoid having an exception arbritraly raised.
     */
    mono_string_to_utf8: ['char*', ['System.String*']],
    getClassMethods: function (klass) {
        var method, methods = {}, iter = pmalloc();

        while ( !(method = MonoApi.mono_class_get_methods(klass, iter)).isNull() ) {
            var methodName = MonoApi.mono_method_get_name(method).readUtf8String();
            if (!methodName.startsWith('<') /*|| methodName.startsWith('.')*/) {
                var methodRef = MonoApi.mono_class_get_method_from_name(klass, Memory.allocUtf8String(methodName), -1);
                var monoSignature = MonoApi.mono_method_signature(methodRef);
                var retType = MonoApi.mono_type_full_name(MonoApi.mono_signature_get_return_type(monoSignature)).readUtf8String();
                var args = MonoApi.getSignatureParams(monoSignature);
                methods[methodName] = { ref: methodRef, args: args, ret: retType };
            }
        }

        return methods;
    },
    getSignatureParams: function (monoSignature) {
        var params, fields = [], iter = pmalloc();

        while ( !(params = MonoApi.mono_signature_get_params(monoSignature, iter)).isNull() )
            fields.push( MonoApi.mono_type_full_name(params).readUtf8String() );

        return fields;
    },
    getClassFields: function (monoClass) {
        var field, fields = [], iter = pmalloc();

        while ( !(field = MonoApi.mono_class_get_fields(monoClass, iter)).isNull() )
            fields.push( 
                MonoApi.mono_field_full_name(field).readUtf8String().split(':')[1] );

        return fields;
    },
    init: function() {
        var monoModule = Process.findModuleByName('mono.dll');
        debug("Process.findModuleByName('mono.dll') ? " + monoModule);
        if (!monoModule) {
            var monoThreadAttach = Module.findExportByName(null, 'mono_thread_attach');
            debug("monoThreadAttach ? " + monoThreadAttach);
            if (monoThreadAttach)
                monoModule = Process.findModuleByAddress(monoThreadAttach);
        }
        if (!monoModule) throw new Error('Mono.dll not found');

        Object.keys(MonoApi).map(function(exportName) {
            var monoApiIter = MonoApi[exportName];
            if (typeof monoApiIter === 'object') {
                var returnValue = monoApiIter[0].endsWith('*') ? 'pointer' : monoApiIter[0];
                var argumentTypes = monoApiIter[1].map(function(t) { return t.endsWith('*') ? 'pointer' : t });
                var exportAddress = Module.findExportByName(monoModule.name, exportName);
                MonoApi[exportName] = new NativeFunction(exportAddress, returnValue, argumentTypes);
            }
        });
    }
};

function intercept(op) {
    var nothingSetSoJustLogMethodArguments = !op.argumentsKeys && !op.onEnterCallback && !op.onLeaveCallback;
    var method = Metadata[op.className].methods[op.methodName];
    debug('Intercepting', op.className + '#' + op.methodName, JSON.stringify(method));
    // TODO assert re compile is necessary
    var monoCompileMethod = MonoApi.mono_compile_method(method.ref);
    Interceptor.attach(monoCompileMethod, {
        onEnter: function (args) {
            var argsValues = {};
            for (var i = 0, l = method.args.length; i < l; i++) {
                var key = op.argumentsKeys ? op.argumentsKeys[i] : i;
                if (key === kIgnoreArg)
                    continue;
                var j = i + 1;
                switch (method.args[i]) {
                    case 'string':
                        argsValues[key] = MonoApi.mono_string_to_utf8(args[j]).readUtf8String();
                        break;
                    case 'long':
                    case 'int':
                        argsValues[key] = parseInt(args[j]);
                        break;
                    default:
                        argsValues[key] = args[j];
                        break;
                }
            }

            if (nothingSetSoJustLogMethodArguments)
                debug(op.className + '#' + op.methodName, JSON.stringify(argsValues, null, 2));

            if (op.onEnterCallback)
                op.onEnterCallback(argsValues);
        },
        onLeave: function (retval) {
            if (op.onLeaveCallback)
                op.onLeaveCallback(retval);
        }
    });
}

function getMetadata(monoImage) {
    // MONO_TABLE_TYPEDEF = 0x2; // https://github.com/mono/mono/blob/master/mono/metadata/blob.h#L56
    for (var i = 1, l = MonoApi.mono_image_get_table_rows(monoImage, 0x2); i < l; ++i) {
        // MONO_TOKEN_TYPE_DEF = 0x2000000 // https://github.com/mono/mono/blob/master/mono/metadata/tokentype.h#L16
        var mClass = MonoApi.mono_class_get(monoImage, 0x2000000 | i);
        var className = MonoApi.mono_class_get_name(mClass).readUtf8String();
        var classNameSpace = MonoApi.mono_class_get_namespace(mClass).readUtf8String();
        try {
            var parentClassName = MonoApi.mono_class_get_name( MonoApi.mono_class_get_parent(mClass) ).readUtf8String();
            if (parentClassName === 'MonoBehaviour' && classNameSpace === '') {
                Metadata[className] = {
                    // namespace: classNameSpace,
                    ref: mClass,
                    methods: MonoApi.getClassMethods(mClass),
                    fields: MonoApi.getClassFields(mClass)
                };
            }
        } catch (e) {
            debug("Error @ getMetadata/mono_class_get_parent", e);
        }
    }
    send({ event: 'METADATA', data: Metadata });
}

function hookMonoLoad() {
    // hooking the method in charge of loading the DLL files
    Interceptor.attach(Module.findExportByName(null, 'mono_assembly_load_from_full'), {
        onEnter: function (args) {
            // passing variables to onLeave scope using 'this'
            this._args = {
                image: args[0], // MonoImage* Image to load the assembly from
                fname: args[1].readUtf8String() // const char* assembly name to associate with the assembly
                // status: args[2], // MonoImageOpenStatus* returns the status condition
                // refonly: args[3] // gboolean Whether this assembly is being opened in "reflection-only" mode.
            };
        },
        onLeave: function (_retval) {
            // Return value: A valid pointer to a MonoAssembly* on success and the status will be set to MONO_IMAGE_OK
            //               or NULL on error.
            if (this._args.fname.endsWith('Assembly-CSharp.dll')) {
                MonoApi.init();
                getMetadata(this._args.image);
                /*placeholder*/
            }
        }
    });
}

function awaitForCondition(func) {
    // From MDN: If this parameter is less than 10, a value of 10 is used. Note that the actual delay may be longer;
    var delay = 10; // Fight for CPU
    var intervalPointer = setInterval(function() {
        // The condition that asserts Mono's required resources can be hooked
        // TODO switch with intercepting dlopen wait for mono.dll ?
        // FIXME use Module.ensureInitialized(name)
        if (Module.findExportByName(null, 'mono_get_root_domain')) {
            clearInterval(intervalPointer);
            func(); // Executing the passed function
        }
    }, delay);
}

// Main
Java.perform(awaitForCondition(hookMonoLoad)); // TODO support iOS
