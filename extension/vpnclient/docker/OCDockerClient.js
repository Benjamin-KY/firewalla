/*    Copyright 2022 Firewalla Inc
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

'use strict';


const log = require('../../../net2/logger.js')(__filename);
const fs = require('fs');
const Promise = require('bluebird');
Promise.promisifyAll(fs);
const exec = require('child-process-promise').exec;
const DockerBaseVPNClient = require('./DockerBaseVPNClient.js');
const YAML = require('../../../vendor_lib/yaml/dist');
const _ = require('lodash');
const f = require('../../../net2/Firewalla.js');

class OCDockerClient extends DockerBaseVPNClient {

  async prepareDockerCompose() {
    log.info("Preparing docker compose file...");
    const src = `${__dirname}/ssl/docker-compose.template.yaml`;
    const content = await fs.readFileAsync(src, {encoding: 'utf8'});
    const dst = `${this._getDockerConfigDirectory()}/docker-compose.yaml`;
    log.info("Writing config file", dst);
    await fs.writeFileAsync(dst, content);
  }

  async prepareConfig(config) {
    log.info("Preparing config file...");

    if (!config)
      return;

    const entries = [];
    const ignoredKeys = ["password", "server"];
    for (const key of Object.keys(config)) {
      if (ignoredKeys.includes(key))
        continue;
      if (config[key] !== null) {
        if (_.isArray(config[key])) {
          // parameter will be specified multiple times in config file if it is an array
          for (const value of config[key]) {
            if (value !== null)
              entries.push(`${key}=${value}`);
            else
              entries.push(`${key}`);
          }
        } else
          entries.push(`${key}=${config[key]}`);
      } else {
        entries.push(`${key}`); // a parameter without value
      }
    }
    const dst = `${this._getDockerConfigDirectory()}/oc.conf`;
    await fs.writeFileAsync(dst, entries.join('\n'), {encoding: 'utf8'}) ;
  }

  async preparePasswd(config = {}) {
    log.info("Preparing passwd file...");
    const dst = `${this._getDockerConfigDirectory()}/passwd`;
    await fs.writeFileAsync(dst, config.password, {encoding: 'utf8'});
  }

  async prepareServer(config = {}) {
    log.info("Preparing server file...");
    const dst = `${this._getDockerConfigDirectory()}/server`;
    await fs.writeFileAsync(dst, config.server, {encoding: 'utf8'});
  }

  _getOutputDirectory() {
    return `${f.getHiddenFolder()}/run/docker/${this.profileId}/output`;
  }

  async _getDNSServersFromFile(file) {
    try {
      const str = await fs.readFileAsync(file, {encoding: 'utf8'});
      const ips = str.split(" ");

      if(!_.isEmpty(ips)) {
        return ips;
      }

    } catch(err) {
      log.error("Got error when getting DNS servers from file, err:", err);
    }

    return [];
  }

  async _getDNSServers() {
    const ipv4s = await this._getDNSServersFromFile(`${this._getOutputDirectory()}/nameserver.ipv4`);
    const ipv6s = await this._getDNSServersFromFile(`${this._getOutputDirectory()}/nameserver.ipv6`);

    return [...ipv4s, ...ipv6s]
      .map((x) => x.trim())
      .filter((x) => x !== "");
  }

  async getMessage() {
    const file = `${this._getOutputDirectory()}/message`;
    return await fs.readFileAsync(file, {encoding: "utf8"}).catch(() => "");
  }

  async getRoutedSubnets() {
    try {
      const base = await super.getRoutedSubnets();
      const file = `${this._getOutputDirectory()}/routes`;

      const str = await fs.readFileAsync(file, {encoding: 'utf8'});
      const routes = str.split(",");

      if(!_.isEmpty(routes)) {
        return routes
          .map((x) => x.trim())
          .filter((x) => x !== "");
      }

    } catch(err) {
      log.error("Got error when getting routes from file, err:", err);
    }

    return [];
  }

  async __prepareAssets() {
    const config = await this.loadJSONConfig();

    if(_.isEmpty(config)) return;

    await this.prepareDockerCompose(config);
    await this.preparePasswd(config);
    await this.prepareServer(config);
    await this.prepareConfig(config);
  }

  async __isLinkUpInsideContainer() {
    try {
      const reason = await fs.readFileAsync(`${this._getOutputDirectory()}/reason`, {encoding: 'utf8'});

      // reference: https://gitlab.com/openconnect/vpnc-scripts/raw/master/vpnc-script
      return ["connect", "reconnect"].includes(reason.trim());
    } catch(err) { // e.g. file not exists, means service is not up
      return false;
    }
  }

  // use same directory as OCVPNClient.js, so that different implementations for the same protocol can be interchanged
  static getConfigDirectory() {
    return `${f.getHiddenFolder()}/run/oc_profile`;
  }

  static getProtocol() {
    return "ssl";
  }

  getEffectiveInterface() {
    return "tun0";
  }

}

module.exports = OCDockerClient;
