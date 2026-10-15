/**
 * @padcom/pico-risc-v-relay: a network for Pico RISC-V's web page, where it
 * has none (GitHub Pages): a user-mode NAT on this machine, which the page's
 * network card reaches over a WebSocket. `npx @padcom/pico-risc-v-relay`
 * runs one (src/cli.ts); this is the same, to build into other servers.
 */
export { isLocalOrigin, serveNetworks, type RelayOptions } from './relay.js'
export { DNS_IP, GATEWAY_IP, GUEST_IP, UserNetwork, type UserNetworkOptions } from './user-network.js'
export { relay, WebSocketConnection } from './websocket.js'
export type { NetworkBackend } from './network.js'
/** Ethernet, ARP, IPv4, ICMP, TCP and UDP packets: building and parsing them. */
export * from './packet.js'
