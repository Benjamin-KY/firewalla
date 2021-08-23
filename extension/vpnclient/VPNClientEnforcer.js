/*    Copyright 2016 Firewalla LLC 
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

const log = require('../../net2/logger.js')(__filename);
const cp = require('child_process');
const ipTool = require('ip');
const util = require('util');
const routing = require('../routing/routing.js');

const iptables = require('../../net2/Iptables.js');
const wrapIptables = iptables.wrapIptables;
const ipset = require('../../net2/Ipset.js');
const platformLoader = require('../../platform/PlatformLoader.js');
const platform = platformLoader.getPlatform();
const Mode = require('../../net2/Mode.js');
const {Address4, Address6} = require('ip-address');

const execAsync = util.promisify(cp.exec);

const VPN_CLIENT_RULE_TABLE_PREFIX = "vpn_client";

class VPNClientEnforcer {
  constructor() {
    return this;
  }

  _getRoutingTableName(vpnIntf) {
    return `${VPN_CLIENT_RULE_TABLE_PREFIX}_${vpnIntf}`;
  }

  async getRtId(vpnIntf) {
    const tableName = this._getRoutingTableName(vpnIntf);
    return await routing.createCustomizedRoutingTable(tableName, routing.RT_TYPE_VC).catch((err) => null);
  }

  async destroyRtId(vpnIntf) {
    const tableName = this._getRoutingTableName(vpnIntf);
    await routing.removeCustomizedRoutingTable(tableName);
  }

  async enforceStrictVPN(vpnIntf) {
    if (!vpnIntf) {
      throw "Interface is not specified";
    }
    const rtId = await this.getRtId(vpnIntf);
    if (!rtId)
      return;
    const rtIdHex = Number(rtId).toString(16);
    let cmd = wrapIptables(`sudo iptables -w -A FW_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -m set ! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst ! -o ${vpnIntf} -j DROP`);
    await execAsync(cmd).catch((err) => {
      log.error(`Failed to enforce IPv4 strict vpn on ${vpnIntf}`, err);
    });
    cmd = wrapIptables(`sudo ip6tables -w -A FW_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -m set ! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst ! -o ${vpnIntf} -j DROP`);
    await execAsync(cmd).catch((err) => {
      log.error(`Failed to enforce IPv6 strict vpn on ${vpnIntf}`, err);
    });
  }

  async unenforceStrictVPN(vpnIntf) {
    if (!vpnIntf) {
      throw "Interface is not specified";
    }
    const rtId = await this.getRtId(vpnIntf);
    if (!rtId)
      return;
    const rtIdHex = Number(rtId).toString(16);
    let cmd = wrapIptables(`sudo iptables -w -D FW_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -m set ! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst ! -o ${vpnIntf} -j DROP`); // do not send to FW_DROP, otherwise it will be bypassed by acl:false policy
    await execAsync(cmd).catch((err) => {
      log.error(`Failed to unenforce IPv4 strict vpn on ${vpnIntf}`, err);
      throw err;
    });
    cmd = wrapIptables(`sudo ip6tables -w -D FW_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -m set ! --match-set ${ipset.CONSTANTS.IPSET_MONITORED_NET} dst,dst ! -o ${vpnIntf} -j DROP`);
    await execAsync(cmd).catch((err) => {
      log.error(`Failed to unenforce IPv6 strict vpn on ${vpnIntf}`, err);
      throw err;
    });
  }

  async enforceVPNClientRoutes(remoteIP, vpnIntf, routedSubnets = [], overrideDefaultRoute = true) {
    if (!vpnIntf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(vpnIntf);
    // ensure customized routing table is created
    const rtId = await routing.createCustomizedRoutingTable(tableName, routing.RT_TYPE_VC);
    await routing.flushRoutingTable(tableName);
    // add policy based rule, the priority 6000 is a bit higher than the firerouter's application defined fwmark
    await routing.createPolicyRoutingRule("all", null, tableName, 6000, `${rtId}/${routing.MASK_VC}`);
    if (platform.isFireRouterManaged()) {
      // on firerouter-managed platform, no need to copy main routing table to the vpn client routing table
      // but need to grant access to wan_routable table for packets from vpn interface
      await routing.createPolicyRoutingRule("all", vpnIntf, "wan_routable", 5000, null, 4);
      // vpn client interface needs to lookup WAN interface local network routes in DHCP mode
      if (await Mode.isDHCPModeOn()) {
        await routing.createPolicyRoutingRule("all", vpnIntf, "global_local", 5000, null, 4);
      }
    } else {
      // copy all routes from main routing table on non-firerouter-managed platform
      let cmd = "ip route list";
      if (overrideDefaultRoute)
        // do not copy default route from main routing table
        cmd = "ip route list | grep -v default";
      const routes = await execAsync(cmd);
      await Promise.all(routes.stdout.split('\n').map(async route => {
        if (route.length > 0) {
          cmd = util.format("sudo ip route add %s table %s", route, tableName);
          await execAsync(cmd).catch((err) => {}); // this usually happens when multiple function calls are executed simultaneously. It should have no side effect and will be consistent eventually
        }
      }));
    }
    for (let routedSubnet of routedSubnets) {
      let formattedSubnet = null;
      let af = 4;
      let addr = new Address4(routedSubnet);
      if (addr.isValid()) {
        af = 4;
        formattedSubnet = `${addr.startAddress().correctForm()}/${addr.subnetMask}`;
      } else {
        addr = new Address6(routedSubnet);
        if (addr.isValid()) {
          af = 6;
          formattedSubnet = `${addr.startAddress().correctForm()}/${addr.subnetMask}`;
        }
      }
      if (!formattedSubnet) {
        log.error(`Malformed route subnet ${routedSubnet}`);
        continue;
      }
      await routing.addRouteToTable(formattedSubnet, remoteIP, vpnIntf, tableName, null, af).catch((err) => {});
      // make routed subnets reachable from all lan networks
      let maskNum = Number(routing.MASK_VC);
      let offset = 0;
      while (maskNum % 2 === 0) {
        offset += 1;
        maskNum = maskNum >>> 1;
      }
      const pref = rtId >>> offset;
      // add routes with different metrics for different vpn client interface
      // in case multiple VPN clients have overlapped subnets, turning off one vpn client will not affect routes of others
      if (platform.isFireRouterManaged())
        await routing.addRouteToTable(formattedSubnet, remoteIP, vpnIntf, "lan_routable", pref, af).catch((err) => {});
      await routing.addRouteToTable(formattedSubnet, remoteIP, vpnIntf, "main", pref, af).catch((err) => {});
    }
    if (overrideDefaultRoute) {
      // then add remote IP as gateway of default route to vpn client table
      await routing.addRouteToTable("default", remoteIP, vpnIntf, tableName).catch((err) => {}); // this usually happens when multiple function calls are executed simultaneously. It should have no side effect and will be consistent eventually
      await routing.addRouteToTable("default", null, null, tableName, null, 6, "unreachable").catch((err) => {}); // add unreachable route in ipv6 table
    }
    // add inbound connmark rule for vpn client interface
    await execAsync(wrapIptables(`sudo iptables -w -t nat -A FW_PREROUTING_VC_INBOUND -i ${vpnIntf} -j CONNMARK --set-xmark ${rtId}/${routing.MASK_ALL}`)).catch((err) => {
      log.error(`Failed to add VPN client ipv4 inbound connmark rule for ${vpnIntf}`, err.message);
    });
    await execAsync(wrapIptables(`sudo ip6tables -w -t nat -A FW_PREROUTING_VC_INBOUND -i ${vpnIntf} -j CONNMARK --set-xmark ${rtId}/${routing.MASK_ALL}`)).catch((err) => {
      log.error(`Failed to add VPN client ipv6 inbound connmark rule for ${vpnIntf}`, err.message);
    });
  }

  async flushVPNClientRoutes(vpnIntf) {
    if (!vpnIntf)
      throw "Interface is not specified";
    const tableName = this._getRoutingTableName(vpnIntf);
    const rtId = await routing.createCustomizedRoutingTable(tableName, routing.RT_TYPE_VC);
    await routing.flushRoutingTable(tableName);
    // remove policy based rule
    await routing.removePolicyRoutingRule("all", null, tableName, 6000, `${rtId}/${routing.MASK_VC}`).catch((err) => {
      log.error(`Failed to remove policy routing rule`, err.message);
    });
    await routing.removePolicyRoutingRule("all", vpnIntf, "wan_routable", 5000, null, 4).catch((err) => {
      log.error(`Failed to remove policy routing rule`, err.message);
    });
    await routing.removePolicyRoutingRule("all", vpnIntf, "global_local", 5000, null, 4).catch((err) => {
      log.error(`Failed to remove policy routing rule`, err.message);
    });
    // remove inbound connmark rule for vpn client interface
    await execAsync(wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_VC_INBOUND -i ${vpnIntf} -j CONNMARK --set-xmark ${rtId}/${routing.MASK_ALL}`)).catch((err) => {
      log.error(`Failed to remove VPN client ipv4 inbound connmark rule for ${vpnIntf}`, err.message);
    });
    await execAsync(wrapIptables(`sudo ip6tables -w -t nat -D FW_PREROUTING_VC_INBOUND -i ${vpnIntf} -j CONNMARK --set-xmark ${rtId}/${routing.MASK_ALL}`)).catch((err) => {
      log.error(`Failed to remove VPN client ipv6 inbound connmark rule for ${vpnIntf}`, err.message);
    });
  }

  _getVPNClientIPSetName(vpnIntf) {
    return `vpn_client_${vpnIntf}_set`;
  }

  async enforceDNSRedirect(vpnIntf, dnsServers, remoteIP) {
    if (!vpnIntf || !dnsServers || dnsServers.length == 0)
      return;
    const rtId = await this.getRtId(vpnIntf);
    if (!rtId)
      return;
    const rtIdHex = Number(rtId).toString(16);
    const tableName = this._getRoutingTableName(vpnIntf);
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      let bin = "iptables";
      let af = 4;
      if (!ipTool.isV4Format(dnsServer) && ipTool.isV6Format(dnsServer)) {
        bin = "ip6tables";
        af = 6;
      }
      // add to vpn client routing table
      await routing.addRouteToTable(dnsServer, remoteIP, vpnIntf, tableName, null, af).catch((err) => {});
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo ${bin} -w -t nat -I FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo ${bin} -w -t nat -I FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo ${bin} -w -t nat -I FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC}  -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo ${bin} -w -t nat -I FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC}  -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }

  async unenforceDNSRedirect(vpnIntf, dnsServers, remoteIP) {
    if (!vpnIntf || !dnsServers || dnsServers.length == 0)
      return;
    const rtId = await this.getRtId(vpnIntf);
    if (!rtId)
      return;
    const rtIdHex = Number(rtId).toString(16);
    const tableName = this._getRoutingTableName(vpnIntf);
    for (let i in dnsServers) {
      const dnsServer = dnsServers[i];
      // remove from vpn client routing table
      if (remoteIP)
        await routing.removeRouteFromTable(dnsServer, remoteIP, vpnIntf, tableName).catch((err) => {});
      // round robin rule for multiple dns servers
      if (i == 0) {
        // no need to use statistic module for the first rule
        let cmd = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p tcp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p udp --dport 53 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      } else {
        let cmd = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p tcp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
        cmd = wrapIptables(`sudo iptables -w -t nat -D FW_PREROUTING_DNS_VPN_CLIENT -m mark --mark 0x${rtIdHex}/${routing.MASK_VC} -p udp --dport 53 -m statistic --mode nth --every ${Number(i) + 1} --packet 0 -j DNAT --to-destination ${dnsServer}`);
        await execAsync(cmd).catch((err) => {
          log.error(`Failed to enforce DNS redirect rule: ${cmd}, intf: ${vpnIntf}, dnsServer: ${dnsServer}`, err);
        });
      }
    }
  }
}

const instance = new VPNClientEnforcer();
module.exports = instance;