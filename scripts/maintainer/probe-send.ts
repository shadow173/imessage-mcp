// Sends a REAL iMessage through a deployed gateway, to check sending end to end. Refuses to run without --yes.
// Prints how many people matched and the send result; never names or message text.
import { connectWithPassword, gatewayArgs } from './lib/gateway.js';

const USAGE = 'scripts/maintainer/probe-send.ts [gateway-url] <person> --yes';
const { base, password, args } = gatewayArgs(USAGE);
const who = args.find((a) => !a.startsWith('--'));
if (!who || !args.includes('--yes')) {
  console.error(`This sends a real message to <person>. Usage: IMESSAGE_MCP_PASSWORD=... npx tsx ${USAGE}`);
  process.exit(64);
}
const intent = 'owner testing that sending works';
const c = await connectWithPassword(base, password);
const sp: any = await c.callTool({ name: 'search_people', arguments: { query: who, format: 'json', intent } });
const people = sp.structuredContent?.people ?? [];
console.log(`matches: ${people.length}`);
for (const p of people)
  console.log(
    `  in_contacts=${p.in_contacts} · handles=${p.handles.map((h: any) => (h.address.includes('@') ? 'email' : 'phone') + '/' + (h.services.join('+') || '?')).join(', ')} · has 1:1 chat=${!!p.dm_chat_id} · messages=${p.message_count}`,
  );
if (people.length !== 1) {
  console.log('not exactly one match; stopping before sending');
  process.exit(1);
}
const s = Date.now();
const r: any = await c.callTool({
  name: 'send_message',
  arguments: {
    to: people[0].person_id,
    text: 'Test message from the iMessage bridge. If you can read this, sending works. 👋',
    idempotency_key: `owner-test-${new Date().toISOString().slice(0, 16)}`,
    intent,
  },
});
const sc = r.structuredContent;
console.log(
  `send: ${r.isError ? r.content[0].text.split('\n').slice(0, 2).join(' | ') : `${sc.disposition} · message_id ${sc.message_id} · retry_safe ${sc.retry_safe}${sc.error ? ` · ${sc.error.code}: ${sc.error.message}` : ''}`} · ${Date.now() - s} ms`,
);
await c.close();
