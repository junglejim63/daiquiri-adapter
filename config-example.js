var config = {
   system: "zchs", // Zionsville Community High School
   // source: "serial",
   source: "Console2CompTimingStart.bin",
   destination: "amqp",
   // destination: "msg2.txt",
   // pc: {port: "COM9", baud: 38400, name: "pc"}, //for Windows system
   pc: {port: "/dev/ttyUSB0", baud: 38400, name: "pc"},   //for linux system
   // cons: {port: "COM10", baud: 38400, name: "cons"},   //for Windows system
   cons: {port: "/dev/ttyUSB1", baud: 38400, name: "cons"},      //for linux system
   amqp: {locator: "cloudamqp.com/sub", user: "username", pass: "password", exchange: "daiquiri-adapter", exType: 'direct', 
          receiveQueue: "daiquiri-commands", retryMin: 1000, retryMax: 30000},
   msg: {
      ignore: [],
      aggregate: [
         {type: "0003", source: "pc", description: "PC Heartbeat", freq:600, meetFreq: 60, idleFreq: 600},
         {type: "0006", source: "cons", description: "Console Heartbeat and TOD clock", freq:600, meetFreq: 5, idleFreq: 600},
         {type: "0005", source: "cons", description: "Timer running tenths", freq: 600, meetFreq: 10, idleFreq: 600}
                 ]
         },
   mgmt: {period: 10},
   localEcho: true
};
exports.config = config;
