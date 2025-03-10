/*    Copyright 2019-2022 Firewalla Inc.
 *
 *    This program is free software: you can redistribute it and/or  modify
 *    it under the terms of the GNU Affero General Public License, version 3,
 *    as published by the Free Software Foundation.
 *
 *    This program is distributed in the hope that it will be useful,
 *    but WITHOUT ANY WARRANTY; without even the implied warranty of
 *    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *    GNU Affero General Public License for more details.
 *
 *    You should have received a copy of the GNU Affero General Public License
 *    along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

'use strict'

const log = require("./logger.js")(__filename);

const fs = require('fs');
const f = require('./Firewalla.js');
const cp = require('child_process');
const platform = require('../platform/PlatformLoader').getPlatform()

const rclient = require('../util/redis_manager.js').getRedisClient()
const sclient = require('../util/redis_manager.js').getSubscriptionClient()
const pclient = require('../util/redis_manager.js').getPublishClient()

const complexNodes = ['sensors', 'apiSensors', 'features', 'userFeatures', 'bro']
const dynamicConfigKey = "sys:features"

const defaultConfig = JSON.parse(fs.readFileSync(f.getFirewallaHome() + "/net2/config.json", 'utf8'));
const platformConfig = getPlatformConfig()

let versionConfigInitialized = false
let versionConfig = null
let cloudConfig = null
let userConfig = null
let config = null;

let dynamicFeatures = null
let features = null

let callbacks = {}


const writeFileAsync = fs.promises.writeFile
const readFileAsync = fs.promises.readFile

const { rrWithErrHandling } = require('../util/requestWrapper.js')

const _ = require('lodash')

async function initVersionConfig() {
  let configServerUrl = null;
  if (f.isDevelopmentVersion()) configServerUrl = 'https://s3-us-west-2.amazonaws.com/fireapp/box_dev.json'
  if (f.isAlpha()) configServerUrl = 'https://s3-us-west-2.amazonaws.com/fireapp/box_alpha.json'
  if (f.isProductionOrBeta()) configServerUrl = 'https://s3-us-west-2.amazonaws.com/fireapp/box.json'

  if (configServerUrl) {
    const options = {
      uri: configServerUrl,
      family: 4,
      method: 'GET',
      maxAttempts: 5,
      retryDelay: 1000,
      json: true
    };
    const response = await rrWithErrHandling(options).catch(err => log.error("Failed to get version config", err.message))
    if (response && response.body) {
      log.info("Load version config successfully.");
      await pclient.publishAsync("config:version:updated", JSON.stringify(response.body))
    }
  }
}

async function removeUserConfig(key) {
  await getUserConfig(true);
  if (key in userConfig) {
    delete userConfig[key]
    let userConfigFile = f.getUserConfigFolder() + "/config.json";
    const configString = JSON.stringify(userConfig, null, 2) // pretty print
    await writeFileAsync(userConfigFile, configString, 'utf8')
    await pclient.publishAsync('config:user:updated', configString)
  }
}

async function updateUserConfig(updatedPart) {
  await getUserConfig(true);
  userConfig = Object.assign({}, userConfig, updatedPart);
  let userConfigFile = f.getUserConfigFolder() + "/config.json";
  const configString = JSON.stringify(userConfig, null, 2) // pretty print
  await writeFileAsync(userConfigFile, configString, 'utf8')
  await pclient.publishAsync('config:user:updated', configString)
}

async function removeUserNetworkConfig() {
  await getUserConfig(true);

  delete userConfig.alternativeInterface;
  delete userConfig.secondaryInterface;
  delete userConfig.wifiInterface;
  delete userConfig.dhcpLeaseTime;

  let userConfigFile = f.getUserConfigFolder() + "/config.json";
  const configString = JSON.stringify(userConfig, null, 2) // pretty print
  await writeFileAsync(userConfigFile, configString, 'utf8')
  await pclient.publishAsync('config:user:updated', configString)
}

async function getUserConfig(reload) {
  if (!userConfig || reload === true) {
    let userConfigFile = f.getUserConfigFolder() + "/config.json";
    userConfig = {};
    if (fs.existsSync(userConfigFile)) {
      userConfig = JSON.parse(await readFileAsync(userConfigFile, 'utf8'));
    }
    log.debug('userConfig reloaded')
  }
  return userConfig;
}

function getPlatformConfig() {
  const path = `${f.getFirewallaHome()}/platform/${platform.getName()}/files/config.json`;
  if (fs.existsSync(path))
    try {
      return JSON.parse(fs.readFileSync(path, 'utf8'));
    } catch (err) {
      log.error('Error parsing platform config', err)
    }

  return {}
}

function getDefaultConfig() {
  return defaultConfig
}

function reloadConfig() {
  const newConfig = {}
  const userConfigFile = f.getUserConfigFolder() + "/config.json";
  userConfig = {};
  for (let i = 0; i !== 5; i++) {
    try {
      if (fs.existsSync(userConfigFile)) {
        userConfig = JSON.parse(fs.readFileSync(userConfigFile, 'utf8'));
        break;
      }
    } catch (err) {
      log.error(`Error parsing user config, retry count ${i}`, err);
      cp.execSync('sleep 1');
    }
  }

  let testConfig = {};
  if (process.env.NODE_ENV === 'test') {
    let testConfigFile = f.getUserConfigFolder() + "/config.test.json";
    if (fs.existsSync(testConfigFile)) {
      testConfig = JSON.parse(fs.readFileSync(testConfigFile, 'utf8'));
      log.warn("Test config is being used", testConfig);
    }
  }

  // later in this array higher the priority
  const prioritized = [defaultConfig, platformConfig, versionConfig, cloudConfig, userConfig, testConfig].filter(Boolean)

  Object.assign(newConfig, ...prioritized);

  // 1 more level of Object.assign grants more flexibility to configurations
  for (const key of complexNodes) {
    newConfig[key] = Object.assign({}, ...prioritized.map(c => c[key]))
  }

  config = newConfig

  reloadFeatures()
}

function getConfig(reload = false) {
  if (!config || reload) reloadConfig()
  return config
}

function isFeatureOn(featureName, defaultValue = false) {
  if (featureName in features)
    return features[featureName]
  else
    return defaultValue
}


async function syncDynamicFeatures() {
  let configs = await rclient.hgetallAsync(dynamicConfigKey);
  if (configs) {
    dynamicFeatures = configs
  } else {
    dynamicFeatures = {}
  }
  log.debug('dynamicFeatures reloaded')
  reloadFeatures()
}

async function syncCloudConfig() {
  const boneInfo = await f.getBoneInfoAsync()
  cloudConfig = boneInfo && boneInfo.cloudConfig
  log.debug('cloudConfig reloaded')
  reloadConfig()
}


async function enableDynamicFeature(featureName) {
  await rclient.hsetAsync(dynamicConfigKey, featureName, '1');
  await pclient.publishAsync("config:feature:dynamic:enable", featureName)
  dynamicFeatures[featureName] = '1'
}

async function disableDynamicFeature(featureName) {
  await rclient.hsetAsync(dynamicConfigKey, featureName, '0');
  await pclient.publishAsync("config:feature:dynamic:disable", featureName)
  dynamicFeatures[featureName] = '0'
}

async function clearDynamicFeature(featureName) {
  await rclient.hdelAsync(dynamicConfigKey, featureName);
  await pclient.publishAsync("config:feature:dynamic:clear", featureName)
  delete dynamicFeatures[featureName]
}

function getDynamicFeatures() {
  return dynamicFeatures
}

function reloadFeatures() {
  const featuresNew = Object.assign({}, config.userFeatures)
  for (const f in dynamicFeatures) {
    featuresNew[f] = dynamicFeatures[f] === '1' ? true : false
  }

  const hiddenFeatures = f.isProductionOrBeta() && Array.isArray(config.hiddenFeatures) && config.hiddenFeatures || []
  for (const f of hiddenFeatures) {
    delete featuresNew[f]
  }

  let firstLoad;
  if (!features) {
    firstLoad = true;
    features = {};
  } else {
    firstLoad = false;
  }
  for (const f in callbacks) {
    if (firstLoad && featuresNew[f] !== undefined) {
      features[f] = featuresNew[f];
      callbacks[f].forEach(c => {
        c(f, featuresNew[f])
      })
    }
    else if (featuresNew[f] && !features[f]) {
      features[f] = true;
      callbacks[f].forEach(c => {
        c(f, true)
      })
    }
    else if (!featuresNew[f] && features[f]) {
      features[f] = false;
      callbacks[f].forEach(c => {
        c(f, false)
      })
    }
  }

  features = featuresNew;
}

function getFeatures() {
  return features
}

sclient.subscribe("config:feature:dynamic:enable")
sclient.subscribe("config:feature:dynamic:disable")
sclient.subscribe("config:feature:dynamic:clear")
sclient.subscribe("config:cloud:updated")
sclient.subscribe("config:user:updated")
sclient.subscribe("config:version:updated")

sclient.on("message", (channel, message) => {
  if (channel.startsWith('config:'))
    log.debug(`got message from ${channel}: ${message}`)

  switch (channel) {
    case "config:feature:dynamic:enable":
      dynamicFeatures[message] = '1'
      reloadFeatures()
      break
    case "config:feature:dynamic:disable":
      dynamicFeatures[message] = '0'
      reloadFeatures()
      break
    case "config:feature:dynamic:clear":
      delete dynamicFeatures[message]
      reloadFeatures()
      break
    case "config:version:updated":
      versionConfigInitialized = true
      versionConfig = JSON.parse(message)
      reloadConfig()
      break
    case "config:cloud:updated":
      cloudConfig = JSON.parse(message)
      reloadConfig()
      break
    case "config:user:updated":
      userConfig = JSON.parse(message)
      reloadConfig()
      break
  }
});

syncDynamicFeatures()
setInterval(() => {
  syncDynamicFeatures()
}, 60 * 1000) // every minute

syncCloudConfig()

if (f.isMain()) {
  initVersionConfig()
} else {
  setTimeout(() => {
    if (!versionConfigInitialized) initVersionConfig()
  }, 10 * 1000)
}

reloadConfig()

function onFeature(feature, callback) {
  if (!callbacks[feature]) {
    callbacks[feature] = []
  }

  callbacks[feature].push(callback)
}

function getTimingConfig(key) {
  return config && config.timing && config.timing[key];
}

function getSimpleVersion() {
  const hash = f.getLatestCommitHash();
  const version = config && config.version;
  return `${version}-${hash}`;
}

function isMajorVersion() {
  const MAJOR_VERSION_MAX_LENGTH = 3;
  const version = config && config.version;
  const versionRegex = /\d+\.(\d+)/;
  const matchResult = versionRegex.exec(version);
  const decimalPart = matchResult[1];
  return decimalPart.length <= MAJOR_VERSION_MAX_LENGTH;
}

class ConfigError extends Error {
  constructor(path) {
    super('Error getting config', Array.isArray(path) ? path.join('.') : path)
    this.path = path
  }
}

// utility class for easier config check and get
// make sure that net2/config.json contains what's necessary
class Getter {
  constructor(basePath) {
    this.basePath = _.toPath(basePath)
  }

  get(path, reload = false) {
    const config = getConfig(reload)
    const configDefault = getDefaultConfig()
    const absPath = this.basePath.concat(_.toPath(path))
    const result = _.get(config, absPath, _.get(configDefault, absPath))
    if (!result) throw new ConfigError(absPath)
    log.debug('get', absPath, 'returns', result)
    return result
  }
}

module.exports = {
  updateUserConfig: updateUserConfig,
  removeUserConfig: removeUserConfig,
  getConfig: getConfig,
  getDefaultConfig,
  getSimpleVersion: getSimpleVersion,
  isMajorVersion: isMajorVersion,
  // getUserConfig,
  getTimingConfig: getTimingConfig,
  isFeatureOn: isFeatureOn,
  getFeatures,
  getDynamicFeatures,
  enableDynamicFeature: enableDynamicFeature,
  disableDynamicFeature: disableDynamicFeature,
  clearDynamicFeature: clearDynamicFeature,
  syncDynamicFeatures,
  onFeature: onFeature,
  removeUserNetworkConfig: removeUserNetworkConfig,
  ConfigError,
  Getter,
};
