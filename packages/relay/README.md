# @padcom/pico-risc-v-relay

**A network for [Pico RISC-V](https://github.com/padcom/pico-risc-v)'s
web page.** A web page can't open sockets, so Debian in the browser has no
network of its own. This relay lends it yours: a user-mode NAT on your
machine, which the page's network card reaches over a WebSocket.

```sh
npx @padcom/pico-risc-v-relay
```

Then open the page with the relay:

**<https://padcom.github.io/pico-risc-v/?relay=ws://localhost:8081>**

(The page's status bar has a link that does the same.) Debian gets an
address by DHCP (10.0.2.15), and `apt update` works. Newer Chrome may ask
whether the page may access your local network: it's asking about the relay,
so say yes. And `ssh -p 2222 root@localhost` reaches the guest's ssh.

It needs Node.js 22.18 or newer.

## Options

```
pico-risc-v-relay [--port <port>] [--origin <origin>]...
```

- `--port`: where it listens (default 8081, on localhost only).
- `--origin`: another site whose pages may use it, such as a fork's GitHub
  Pages (`--origin https://you.github.io`).

## Who may use it

The NAT reaches whatever your machine reaches, including its own services:
10.0.2.2 in the guest is your machine's localhost. So not every web site
open in your browser may connect to it. Only pages from `localhost`, from
Pico RISC-V's GitHub Pages (`https://padcom.github.io`), and from the origins
you add with `--origin` can.

## As a library

The same NAT, to build into a server of your own:

```js
import { createServer } from 'node:http'
import { isLocalOrigin, serveNetworks } from '@padcom/pico-risc-v-relay'

const server = createServer()
serveNetworks(server, { path: '/net', allowed: origin => origin === undefined || isLocalOrigin(origin) })
server.listen(8081)
```

`UserNetwork` is the NAT itself: Ethernet frames in and out, with DHCP, DNS,
TCP, UDP and ping toward the host's network.

## Who wrote it

Every line of it was written by Claude (Anthropic's AI), in Claude Code, as
part of [Pico RISC-V](https://github.com/padcom/pico-risc-v).

License: ISC.
