// Sends a REAL tapback through a deployed gateway, to check the Private API tier: reacts to the person's latest
// message in your 1:1 chat. Refuses to run without --yes. Prints only whether the reaction landed; never message text.
import { connectWithPassword, gatewayArgs } from './lib/gateway.js';

const USAGE =
  'scripts/maintainer/probe-react.ts [gateway-url] <person> [love|like|dislike|laugh|emphasize|question] --yes';
const GLYPHS: Record<string, string> = {
  love: '❤️',
  like: '👍',
  dislike: '👎',
  laugh: '😂',
  emphasize: '‼️',
  question: '❓',
};
const { base, password, args } = gatewayArgs(USAGE);
const [who, reaction = 'like'] = args.filter((a) => !a.startsWith('--'));
if (!who || !GLYPHS[reaction] || !args.includes('--yes')) {
  console.error(`This sends a real reaction. Usage: IMESSAGE_MCP_PASSWORD=... npx tsx ${USAGE}`);
  process.exit(64);
}
const intent = 'owner testing reactions on a test contact';
const c = await connectWithPassword(base, password);
const person: any = await c.callTool({
  name: 'get_person',
  arguments: { person: who, include_groups: false, include_stats: false, intent },
});
const chatId = person.structuredContent?.dm_chat_id;
if (!chatId) {
  console.log('no 1:1 chat found');
  process.exit(1);
}
const conv: any = await c.callTool({
  name: 'read_conversation',
  arguments: { chat: chatId, limit: 10, format: 'json', intent },
});
const theirs = [...conv.structuredContent.messages].reverse().find((m: any) => m.from !== 'me' && !m.unsent);
if (!theirs) {
  console.log('no message from them in the last 10');
  process.exit(1);
}
const s = Date.now();
const r: any = await c.callTool({ name: 'react', arguments: { message_id: theirs.message_id, reaction, intent } });
const text = r.content?.map((x: any) => x.text).join('\n') ?? '';
const glyph = GLYPHS[reaction];
console.log(
  r.isError
    ? `error: ${text.split('\n')[0]}`
    : `reaction ${glyph} from You present on ${theirs.message_id}: ${text.includes(`${glyph} You`)} · ${Date.now() - s} ms`,
);
await c.close();
