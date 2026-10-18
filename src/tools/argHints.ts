// "Did you mean" hints for arguments a tool doesn't have.

const ARG_SYNONYMS: Record<string, string[]> = {
  sender: ['from', 'person'],
  author: ['from', 'person'],
  by: ['from'],
  from_person: ['from', 'person'],
  with: ['chat', 'person'],
  name: ['title', 'person', 'query'],
  group_name: ['title'],
  new_name: ['title'],
  new_title: ['title'],
  message: ['text', 'message_id'],
  body: ['text'],
  content: ['text'],
  msg: ['text', 'message_id'],
  schedule: ['send_at'],
  scheduled_at: ['send_at'],
  at: ['send_at', 'remind_at'],
  when: ['send_at', 'remind_at', 'on'],
  time: ['send_at', 'remind_at'],
  remind: ['remind_at'],
  aliases: ['add_aliases'],
  alias: ['add_aliases'],
  labels: ['add'],
  tags: ['add'],
  tag: ['add', 'label'],
  since: ['after'],
  until: ['before'],
  start: ['after'],
  end: ['before'],
  date: ['on'],
  day: ['on'],
  chat_id: ['chat', 'to'],
  conversation: ['chat'],
  conversation_id: ['chat'],
  thread: ['chat'],
  group: ['chat', 'title'],
  person_id: ['person', 'to'],
  contact: ['person', 'to'],
  recipient: ['to'],
  recipients: ['to', 'participants'],
  members: ['participants'],
  phone: ['to', 'person'],
  q: ['query'],
  search: ['query'],
  text: ['query'],
  keyword: ['query'],
  keywords: ['query'],
  term: ['query'],
  max: ['limit'],
  count: ['limit'],
  max_results: ['limit'],
  page: ['cursor'],
  next_cursor: ['cursor'],
  page_token: ['cursor'],
  id: ['message_id', 'attachment_id', 'draft_id', 'person', 'chat'],
  emoji: ['reaction'],
  tapback: ['reaction'],
  kind: ['type', 'reaction'],
  chat_type: ['type'],
  type: ['chat_type', 'types', 'attachment_type'],
  image: ['image_base64'],
  photo: ['image_base64'],
  icon: ['image_base64'],
  image_url: ['image_base64'],
  photo_url: ['image_base64'],
};

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The valid argument an unknown key most likely meant: synonyms, camelCase, plurals, "_id" suffixes, then a near
 * spelling.
 */
export function suggestArg(key: string, known: Set<string>): string | undefined {
  const snake = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const valid = [...known].filter((k) => k !== 'intent' && k !== key);
  const cands = [
    snake,
    ...(ARG_SYNONYMS[snake] ?? []),
    snake.endsWith('s') ? snake.slice(0, -1) : `${snake}s`,
    snake.replace(/_ids?$/, ''),
  ];
  return (
    cands.find((c) => valid.includes(c)) ??
    valid.find((k) => k.startsWith(`${snake}_`)) ??
    (snake.length >= 4
      ? valid
          .map((k) => [k, editDistance(snake, k)] as const)
          .filter(([, d]) => d <= 2)
          .sort((x, y) => x[1] - y[1])[0]?.[0]
      : undefined)
  );
}

/** "sender (did you mean from?), x" */
export function describeUnknown(unknown: string[], known: Set<string>): string {
  return unknown
    .map((k) => {
      const s = suggestArg(k, known);
      return s ? `${k} (did you mean ${s}?)` : k;
    })
    .join(', ');
}
