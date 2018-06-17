
module.exports = function(RED) {
    "use strict";
    var settings = RED.settings;
    var events = require("events");
    var serialp = require("serialport");
    var bufMaxSize = 32768;  // Max serial buffer size, for inputs...

    // TODO: 'serialPool' should be encapsulated in SerialPortNode

    // Configuration Node
    function SerialPortNode(n) {
        RED.nodes.createNode(this,n);
        this.serialport = n.serialport;
        this.newline = n.newline; /* overloaded: split character, timeout, or character count */
        this.addchar = n.addchar || "false";
        this.serialbaud = parseInt(n.serialbaud) || 57600;
        this.databits = parseInt(n.databits) || 8;
        this.parity = n.parity || "none";
        this.stopbits = parseInt(n.stopbits) || 1;
        this.bin = n.bin || "false";
        this.out = n.out || "char";
    }
    RED.nodes.registerType("serial-port",SerialPortNode);


    // receives msgs and sends them to the serial port
    function SerialOutNode(n) {
        RED.nodes.createNode(this,n);
        this.serial = n.serial;
        this.serialConfig = RED.nodes.getNode(this.serial);

        if (this.serialConfig) {
            var node = this;
            node.port = serialPool.get(this.serialConfig);

            node.on("input",function(msg) {
                if (!msg.hasOwnProperty("payload")) { return; } // do nothing unless we have a payload
                var payload = node.port.encodePayload(msg.payload);
                node.port.write(payload,function(err,res) {
                    if (err) {
                        var errmsg = err.toString().replace("Serialport","Serialport "+node.port.serial.path);
                        node.error(errmsg,msg);
                    }
                });
            });
            node.port.on('ready', function() {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            node.port.on('closed', function() {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });
        }
        else {
            this.error(RED._("serial.errors.missing-conf"));
        }

        this.on("close", function(done) {
            if (this.serialConfig) {
                serialPool.close(this.serialConfig.serialport,done);
            }
            else {
                done();
            }
        });
    }
    RED.nodes.registerType("serial out",SerialOutNode);


    // receives data from the serial port and emits msgs
    function SerialInNode(n) {
        RED.nodes.createNode(this,n);
        this.serial = n.serial;
        this.serialConfig = RED.nodes.getNode(this.serial);

        if (this.serialConfig) {
            var node = this;
            node.tout = null;
            node.status({fill:"grey",shape:"dot",text:"node-red:common.status.not-connected"});
            node.port = serialPool.get(this.serialConfig);

            this.port.on('data', function(payload, port) {
                node.send({payload:payload, port:port});
            });
            this.port.on('ready', function() {
                node.status({fill:"green",shape:"dot",text:"node-red:common.status.connected"});
            });
            this.port.on('closed', function() {
                node.status({fill:"red",shape:"ring",text:"node-red:common.status.not-connected"});
            });
        }
        else {
            this.error(RED._("serial.errors.missing-conf"));
        }

        this.on("close", function(done) {
            if (this.serialConfig) {
                serialPool.close(this.serialConfig.serialport,done);
            }
            else {
                done();
            }
        });
    }
    RED.nodes.registerType("serial in",SerialInNode);


    var serialPool = (function() {
        var connections = {};
        return {
            get:function(serialConfig) {
                // make local copy of configuration -- perhaps not needed?
                var port      = serialConfig.serialport,
                    baud      = serialConfig.serialbaud,
                    databits  = serialConfig.databits,
                    parity    = serialConfig.parity,
                    stopbits  = serialConfig.stopbits,
                    newline   = serialConfig.newline,
                    spliton   = serialConfig.out,
                    binoutput = serialConfig.bin,
                    addchar   = serialConfig.addchar;
                var id = port;
                // just return the connection object if already have one
                // key is the port (file path)
                if (connections[id]) { return connections[id]; }

                // State variables to be used by the on('data') handler
                var i = 0; // position in the buffer
                // .newline is misleading as its meaning depends on the split input policy:
                //   "char"  : a msg will be sent after a character with value .newline is received
                //   "time"  : a msg will be sent after .newline milliseconds
                //   "count" : a msg will be sent after .newline characters
                // if we use "count", we already know how big the buffer will be
                var bufSize = spliton == "count" ? Number(newline): bufMaxSize;
                var buf = new Buffer(bufSize);

                var splitc; // split character
                // Parse the split character onto a 1-char buffer we can immediately compare against
                if (newline.substr(0,2) == "0x") {
                    splitc = new Buffer([parseInt(newline)]);
                }
                else {
                    splitc = new Buffer(newline.replace("\\n","\n").replace("\\r","\r").replace("\\t","\t").replace("\\e","\e").replace("\\f","\f").replace("\\0","\0")); // jshint ignore:line
                }

                connections[id] = (function() {
                    var obj = {
                        _emitter: new events.EventEmitter(),
                        serial: null,
                        _closing: false,
                        tout: null,
                        on: function(a,b) { this._emitter.on(a,b); },
                        close: function(cb) { this.serial.close(cb); },
                        encodePayload: function (payload) {
                            if (!Buffer.isBuffer(payload)) {
                                if (typeof payload === "object") {
                                    payload = JSON.stringify(payload);
                                }
                                else {
                                    payload = payload.toString();
                                }
                                if ((spliton === "char") && (addchar === true)) { payload += splitc; }
                            }
                            else if ((spliton === "char") && (addchar === true) && (splitc !== "")) {
                                payload = Buffer.concat([payload,splitc]);
                            }
                            return payload;
                        },
                        write: function(m,cb) { this.serial.write(m,cb); },
                    }
                    //newline = newline.replace("\\n","\n").replace("\\r","\r");
                    var olderr = "";
                    var setupSerial = function() {
                        obj.serial = new serialp(port,{
                            baudRate: baud,
                            dataBits: databits,
                            parity: parity,
                            stopBits: stopbits,
                            //parser: serialp.parsers.raw,
                            autoOpen: true
                        }, function(err, results) {
                            if (err) {
                                if (err.toString() !== olderr) {
                                    olderr = err.toString();
                                    RED.log.error(RED._("serial.errors.error",{port:port,error:olderr}));
                                }
                                obj.tout = setTimeout(function() {
                                    setupSerial();
                                }, settings.serialReconnectTime);
                            }
                        });
                        obj.serial.on('error', function(err) {
                            RED.log.error(RED._("serial.errors.error",{port:port,error:err.toString()}));
                            obj._emitter.emit('closed');
                            obj.tout = setTimeout(function() {
                                setupSerial();
                            }, settings.serialReconnectTime);
                        });
                        obj.serial.on('close', function() {
                            if (!obj._closing) {
                                RED.log.error(RED._("serial.errors.unexpected-close",{port:port}));
                                obj._emitter.emit('closed');
                                obj.tout = setTimeout(function() {
                                    setupSerial();
                                }, settings.serialReconnectTime);
                            }
                        });
                        obj.serial.on('open',function() {
                            olderr = "";
                            RED.log.info(RED._("serial.onopen",{port:port,baud:baud,config: databits+""+parity.charAt(0).toUpperCase()+stopbits}));
                            if (obj.tout) { clearTimeout(obj.tout); }
                            //obj.serial.flush();
                            obj._emitter.emit('ready');
                        });

                        obj.serial.on('data',function(d) {
                            function emitData(data) {
                                var m = Buffer.from(data);
                                if (binoutput !== "bin") { m = m.toString(); }
                                obj._emitter.emit('data',
                                    /* payload */ m,
                                    /* port */ port);
                            }

                            for (var z=0; z<d.length; z++) {
                                var c = d[z];
                                // handle the trivial case first -- single char buffer
                                if ((newline === 0)||(newline === "")) {
                                    emitData(new Buffer([c]));
                                    continue;
                                }

                                // save incoming data into local buffer
                                buf[i] = c;
                                i += 1;

                                // do the timer thing
                                if (spliton === "time") {
                                    // start the timeout at the first character
                                    if (!obj.tout) {
                                        obj.tout = setTimeout(function () {
                                            obj.tout = null;
                                            emitData(buf.slice(0, i));
                                            i=0;
                                        }, newline);
                                    }
                                }
                                // count bytes into a buffer...
                                else if (spliton === "count") {
                                    if ( i >= parseInt(newline)) {
                                        emitData(buf.slice(0,i));
                                        i=0;
                                    }
                                }
                                // look to match char...
                                else if (spliton === "char") {
                                    if ((c === splitc[0]) || (i === bufMaxSize)) {
                                        emitData(buf.slice(0,i));
                                        i=0;
                                    }
                                }
                            }
                        });
                        // obj.serial.on("disconnect",function() {
                        //     RED.log.error(RED._("serial.errors.disconnected",{port:port}));
                        // });
                    }
                    setupSerial();
                    return obj;
                }());
                return connections[id];
            },
            close: function(port,done) {
                if (connections[port]) {
                    if (connections[port].tout != null) {
                        clearTimeout(connections[port].tout);
                    }
                    connections[port]._closing = true;
                    try {
                        connections[port].close(function() {
                            RED.log.info(RED._("serial.errors.closed",{port:port}));
                            done();
                        });
                    }
                    catch(err) { }
                    delete connections[port];
                }
                else {
                    done();
                }
            }
        }
    }());

    RED.httpAdmin.get("/serialports", RED.auth.needsPermission('serial.read'), function(req,res) {
        serialp.list(function (err, ports) {
            res.json(ports);
        });
    });
}
