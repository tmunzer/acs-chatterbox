var slackAccount = require("../config").slackAccount;
var devAccount = require("../config").devAccount;

var CronJob = require("cron").CronJob;
var API = require("./aerohive/api/main");
var Acs = require("./models/acs");
var Device = require("./models/devices");
var Slack = require("./models/slack");
var Spark = require("./models/spark");
var slackMessage = require("./slack/messages");
var sparkMessage = require("./spark/messages");


function sendMessages(account, deviceMessages) {
    slackMessage.sendMessages(account, deviceMessages);
    sparkMessage.sendMessages(account, deviceMessages);
}

function sendError(account, error) {
    console.error("\x1b[31mERROR\x1b[0m:", error);
    slackMessage.error(account, error);
    sparkMessage.error(account, error);
}

function removeOldDevices(devicesInDB, account, deviceMessages) {
    var devicesDone = 0;
    if (devicesInDB.length > 0) devicesInDB.forEach(function (deviceInDB) {
        if (!deviceInDB.present)
            Device.find({ _id: deviceInDB._id }).remove(function (err) {
                if (err) sendError(account, err);
                else deviceMessages.removed.push(deviceInDB);
                devicesDone++;
                if (devicesDone == devicesInDB.length) sendMessages(account, deviceMessages);
            });
        else {
            devicesDone++;
            if (devicesDone == devicesInDB.length) sendMessages(account, deviceMessages);
        }
    })
    else sendMessages(account, deviceMessages);
}

function checkDevices() {
    // Get ACS accounts
    Acs
        .where("expireAt").gt(0)
        .populate("slack")
        .populate("spark")
        .exec(function (err, accounts) {
            // Loop on ACS accounts
            if (err) sendError(account, err);
            else accounts.forEach(function (account) {
                // If the ACS access token is still valid, get Devices for the current ACS account
                if (account.expireAt > new Date().valueOf())
                    Device
                        .find({ 'ownerId': account.ownerId })
                        .exec(function (err, devicesInDB) {
                            // Retrieve the devices status from ACS
                            if (err) sendError(account, err);
                            // only request ACS data if a Slack account or a Spark account are configured
                            else if ((account.slack && account.slack.length > 0) || (account.spark && account.spark.length > 0))
                                API.monitor.devices.devices(account, devAccount, function (err, devices) {
                                    if (err) sendError(account, err);
                                    else {
                                        var deviceMessages = { added: [], removed: [], updated: [] }
                                        // ACS Devices = "nothing to do" + "updated devices" + "added devices" + "SIMU"
                                        var devicesDone = 0;
                                        console.info("\x1b[32minfo\x1b[0m:", " -- Account " + account.ownerId + " has " + devices.length + " devices");
                                        // for each device from ACS
                                        devices.forEach(function (device) {
                                            // filter on REAL devices
                                            if (device.simType.indexOf("REAL") >= 0) {
                                                var isPresent = false;
                                                // retrieve the current device from ACS into the devoce from DB                                                                                
                                                devicesInDB.forEach(function (deviceInDB) {
                                                    if (device.deviceId == deviceInDB.deviceId) {
                                                        // mark the current device as 'present in Db' (will not add it later)
                                                        isPresent = true
                                                        // mark the current deviceInDB as 'present in ACS' (will not remove it later)
                                                        deviceInDB.present = true;
                                                        // check the status change
                                                        if (device.connected != deviceInDB.connected)
                                                            Device.update({ _id: deviceInDB._id }, device, function (err, savedDevice) {
                                                                if (err) sendError(account, err);
                                                                else deviceMessages.updated.push(device);
                                                                devicesDone++;
                                                                if (devicesDone == devices.length) removeOldDevices(devicesInDB, account, deviceMessages)
                                                            })
                                                        // if nothing changed
                                                        else {
                                                            devicesDone++;
                                                            if (devicesDone == devices.length) removeOldDevices(devicesInDB, account, deviceMessages)
                                                        }
                                                    }
                                                })
                                                // save the new device into DB
                                                if (!isPresent)
                                                    Device(device).save(function (err, savedDevice) {
                                                        if (err) sendError(account, err);
                                                        else deviceMessages.added.push(device);
                                                        devicesDone++;
                                                        if (devicesDone == devices.length) removeOldDevices(devicesInDB, account, deviceMessages)
                                                    })
                                            } else {
                                                // SIMU +1
                                                devicesDone++;
                                                if (devicesDone == devices.length) removeOldDevices(devicesInDB, account, deviceMessages)
                                            }
                                        })
                                    }
                                })
                        });
                else sendError(account, "ACS Access Token no longer valid for ownerID " + account.ownerId);
            })
        });
}

module.exports.devices = function () {
    //===============CREATE CRON=================    
    console.info("\x1b[32minfo\x1b[0m:", "init turn");
    checkDevices();
    try {
        new CronJob({
            cronTime: "0 */1 * * * *",
            onTick: function () {
                console.info("\x1b[32minfo\x1b[0m:", "new turn");
                checkDevices();
            },
            start: true
        });
    } catch (ex) {
        console.error("\x1b[31mERROR\x1b[0m:", "cron pattern not valid");
    }
}