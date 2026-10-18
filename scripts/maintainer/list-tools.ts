// Prints the tool names a deployed gateway serves. Signs in with the owner password; reads no message data.
import { connectWithPassword, gatewayArgs } from './lib/gateway.js';

const { base, password } = gatewayArgs('scripts/maintainer/list-tools.ts [gateway-url]');
const c = await connectWithPassword(base, password);
const { tools } = await c.listTools();
console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
await c.close();
