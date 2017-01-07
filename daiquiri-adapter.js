//*******************************************************
// Captures serial string delimited by Hex 01 (ASCII SOH Start of Header) and Hex 04 (ASCII EOT End of Transmission)
//   Usage: $ node DAKQuery_tap.js config.js 
//*******************************************************
//Load required modules
var rl = require('readline');
var fs = require('fs');
var amqp = require('amqplib/callback_api');
var SerialPort = require("serialport");
var util = require("util");
var events = require("events");
var repl = require("repl");

var i;

//*******************************************
// Daiquiri Adapter queue
//*******************************************
function DaiquiriAdapterQueue(config) {
   events.EventEmitter.call(this);
   this.meet = "Idle";
   this.config = config;
   this.offlinePubQueue = []; //array for holding messages when queue is not connected
   this.amqpQueueOpts = {exclusive: false, durable: false, autoDelete: false, messageTtl: 10000, arguments: {}};
   this.ampqPublishChannel = null;
   this.ampqSubscribeChannel = null;
   this.ampqState = "unconnected";
   this.amqpURL = 'amqp://'+config.amqp.user+':'+config.amqp.pass+'@'+config.amqp.locator;
   this.amqpRetry = config.amqp.retryMin;
   if (config.destination == "amqp") {
      startAMQP(this);
   }
   startInput(this);
 }
util.inherits(DaiquiriAdapterQueue, events.EventEmitter);

//Set aggregating frequency to meet frequency (usually more rapid, like running clock once per second)
DaiquiriAdapterQueue.prototype.setMeet = function(meetName) {
   this.inMeet = meetName || "Unnamed Meet";
   for (i = 0; i < this.config.msg.aggregate.length; i++) {
      this.config.msg.aggregate[i].freq = this.config.msg.aggregate[i].meetFreq;
   }
   console.log("[%s] setMeet(): Fast logging frequency set for meet: %s", (new Date()).toISOString(), meetName);
}

//Set aggregating frequency to idle frequency (usually slower, like running clock once per minute.  Saves on queue bandwidth when idle)
DaiquiriAdapterQueue.prototype.clearMeet = function() {
   this.inMeet = "Idle";
   for (i = 0; i < this.config.msg.aggregate.length; i++) {
      this.config.msg.aggregate[i].freq = this.config.msg.aggregate[i].idleFreq;
   }
   console.log("[%s] clearMeet(): Idle logging frequency set", (new Date()).toISOString());
}

var q = new DaiquiriAdapterQueue(require("./"+process.argv[2]).config);
module.exports.daiquiriAdapter = q;

//A "local" node repl with a custom prompt
var localREPL = repl.start("daiquiri-adapter::"+q.config.system+"> ");
localREPL.context.q = q;

//*******************************************************
//AMQP Port Setup
//*******************************************************
function retryAMQP(q) {
   q.amqpRetry = Math.min(q.amqpRetry + 2000, q.config.amqp.retryMax);
   q.ampqState = "closed";
   setTimeout(function(){startAMQP(q);}, q.amqpRetry);
}

function startAMQP(q) {
   amqp.connect(q.amqpURL, function(err, conn) {
      if (err) {
         console.error(printdate()+" Error creating connection to AMQP queue: "+q.amqpURL+", "+err);
         retryAMQP(q);
      } else {
         conn.on('close', function() {
            console.error('Connection to '+q.amqpURL+' unexpectedly closed.');
            retryAMQP(q);
         });
         conn.on('error', function() {
            console.error('Error on Connection to '+q.amqpURL+'.');
            retryAMQP(q);
         });
         //Create Publish Channel
         conn.createChannel(function(err, ch) {
            if (err) {
               console.error(printdate()+" Error creating Publish channel on AMQP queue: "+q.amqpURL+", "+err);
               conn.close();
               retryAMQP(q);
            } else {
               q.ampqPublishChannel = ch;
               // Create link to Exchange (publish)
               ch.assertExchange(q.config.amqp.exchange, q.config.amqp.exType, {durable: true}, function(err, ok){
                  if (err) {
                     console.error(printdate()+" Error asserting exchange on AMQP exchange: "+q.amqpURL+", "+err);
                     conn.close();
                     retryAMQP(q);
                  } else {
                     //queue is ready, start input
                     q.ampqState = "open";
                     q.amqpRetry = q.config.amqp.retryMin;
                     //send all messages saved while offline
                     while (q.offlinePubQueue.length > 0) {
                        var x = q.offlinePubQueue.shift();
                        publish(q, x);
                     }
                     ch.on('error', function(err) {
                        console.error('Channel to '+q.amqpURL+' error: '+err);
                        conn.close();
                        retryAMQP(q);
                     });
                 }
               });
            }
         });
         //Create Subscribe Channel
         conn.createChannel(function(err, ch) {
            if (err) {
               console.error(printdate()+" Error creating Subscribe channel on AMQP queue: "+q.amqpURL+", "+err);
               conn.close();
               retryAMQP(q);
            } else {
               q.ampqSubscribeChannel = ch;
               // Create link to Queue (subscribe)
               ch.assertQueue(q.config.amqp.receiveQueue + "-" + q.config.system);
               ch.consume(q.config.amqp.receiveQueue + "-" + q.config.system, function(msg) {
                  consume(q.ampqSubscribeChannel, msg, q);
               });
               ch.on('error', function(err) {
                  console.error('Channel to '+q.amqpURL+' error: '+err);
                  conn.close();
                  retryAMQP(q);
               });
            }
         });
      }    
   });
}

function startInput(q) {
   //*******************************************************
   //Input file and Serial Port Setup
   //*******************************************************
   if (q.config.source == "serial") {
   //pc port
      var pcPort = new SerialPort(q.config.pc.port, {
        baudrate: q.config.pc.baud,
        parser: SerialPort.parsers.readline("\u0004") //eol is "EOT", ASCII 04
      });
      pcPort.tagName = q.config.pc.name;
      pcPort.on('open', function() {
         console.log(printdate()+" "+pcPort.tagName + " on port " + q.config.pc.port + " is open.");
         pcPort.on('data', function(data){messageRx(q, data, pcPort, Date.now());});
      });
      pcPort.on('error', function(err){portError(err, pcPort);});

      //console port
      var consPort = new SerialPort(q.config.cons.port, {
        baudrate: q.config.cons.baud,
        parser: SerialPort.parsers.readline("\u0004") //eol is "EOT", ASCII 04
      });
      consPort.tagName = q.config.cons.name;
      consPort.on('open', function() {
         console.log(printdate()+" "+consPort.tagName + " on port " + q.config.cons.port + " is open.");
         consPort.on('data', function(data){messageRx(q, data, consPort, Date.now());});
      });
      consPort.on('error', function(err){portError(err, consPort);});
   } else {
      //attempt to open input file
      var rs = fs.createReadStream(q.config.source);
      var lineReader = rl.createInterface({input: rs});
      var lines = [];
      lineReader.on('line', function (line) {
         //console.log('Line from file:', line);
         lines.push(line);
      });
      lineReader.on('close', function (line) {
         lines.reverse();
         popALine();
      });
      function popALine() {
         if (lines.length > 0) {
            var line = lines.pop();
            messageRx(q, line, {tagName: 'file'}, Date.now());
            setTimeout(popALine, 100);
         } else {
            sendMsg(q, mgmtData);
            setTimeout(function(){process.exit();}, 5000);
         }
      }
   }
}

//*******************************************************
//Message Handling Setup
//*******************************************************
var mgmtData = {start: Date.now(), latest: null, m: {unknown:{i: false, a: false, f: 0, cnt: 0}}};
for (i = 0; i < q.config.msg.ignore.length; i++) {
   mgmtData.m[q.config.msg.ignore[i].type] = {i: true, a: false, f: 0, cnt: 0};
}
for (i = 0; i < q.config.msg.aggregate.length; i++) {
   mgmtData.m[q.config.msg.aggregate[i].type] = {i: false, a: true, f: q.config.msg.aggregate[i].freq, cnt: 0};
}

//Send message summary periodically if not 0
if (q.config.mgmt.period > 0) {
   setTimeout(SendmgmtDataTotals, q.config.mgmt.period*1000);
}
function SendmgmtDataTotals() {
   sendMsg(q, mgmtData);
   console.dir(mgmtData);
   setTimeout(SendmgmtDataTotals, q.config.mgmt.period*1000);
}


//*******************************************************
//Process Messages
//*******************************************************
function messageRx(q, data, p, inTime) {
   //check for standard message type
   data = data.replace(/\n|\r/gi,'');
   var msgType;
   if (data.length < 12 ||        // min msg length 000300000B5 12 without EOT ASCII(04) End of Text
       data[0] !== '\u0001' ||    // 1st char is SOH ASCII 01 Start of header
       data[10] !== '\u0002' ||   // 10th char is STX ASCII 02 Start of text
       !chksum(data)) {           // Checksum does not match last 2 chars 
      msgType = 'unknown';
   } else {
      //Appears to be a valid message
      data = data.replace(/\u0001|\u0004|\n|\r/gi,'');
      msgType = data.substr(0,4);
      //add message type if does not already exist
      if (typeof mgmtData.m[msgType] === 'undefined') {
         mgmtData.m[msgType] = {i: false, a: false, f: 0, cnt: 0};
      }
   }
   mgmtData.m[msgType].cnt++;
   if (mgmtData.m[msgType].i) {return;}   //do not further process messages to ignore
   if (mgmtData.m[msgType].a && 
      (mgmtData.m[msgType].cnt % mgmtData.m[msgType].f !== 0)) {return;} //do not further process insufficient aggregated messages
   //send message
   sendMsg(q, {rxTime: inTime, dir: p.tagName, type: msgType, raw: data});
}

//*******************************************************
//Send Message to AMQP or a file
//*******************************************************
function sendMsg(q, m) {
   if (q.config.localEcho && typeof m.dir !== 'undefined') {
      console.log(printdate() + " from "+ (m.dir + '    ').substr(0,4) + ": " + m.raw);
   }
   if (q.config.destination == "amqp") {
      publish(q,{exchange:q.config.amqp.exchange, routingKey: q.config.system, content: new Buffer(JSON.stringify(m))});
   } else {
      //attempt to output file
      fs.appendFile(q.config.destination, JSON.stringify(m)+"\n", function(err) {if (err) {return console.error(err);}});
   }
}

//*******************************************************
//AMQP publish
//*******************************************************
function publish(q, x) {
   if (q.ampqState == 'open') {
      q.ampqPublishChannel.publish(x.exchange, x.routingKey, x.content);
   } else {
      q.offlinePubQueue.push(x);
   }
}

//*******************************************************
//AMQP consume
//*******************************************************
function consume(ch, msg, q) {
   try {
      ch.ack(msg);
      console.log("[%s]", msg.content.toString());
      var content = JSON.parse(msg.content.toString());
      console.log("[%s] Message received from queue: %s", (new Date()).toISOString(), JSON.stringify(content));
      if (content.setMeet) q.setMeet(content.setMeet);
      if (content.clearMeet) q.clearMeet();
   } catch(e) {
      console.log("[%s] Invalid Message received from queue: %s", (new Date()).toISOString(), e);
      console.dir(msg);
   }
}

//*******************************************************
//port error
//*******************************************************
function portError(e,port) {
   console.error(printdate()+" Port error on port from "+port.tagName+".  Exiting...");
   process.exit();
}

function printdate(dateInt) {
   dateInt = dateInt || Date.now();
   var d = new Date(dateInt);
   return d.toLocaleDateString() + " " + d.toLocaleTimeString();
}

function chksum(d) {
   d = d.replace(/\u0001|\u0004|\n|\r/gi,'');
   var chk = parseInt("0x"+d.substr(d.length-2, 2), 16);
   var sum = 0;
   for (var i = 0; i< d.length-2; i++) {
      sum += d.charCodeAt(i);
   }
   return (chk === (sum % 256));
}