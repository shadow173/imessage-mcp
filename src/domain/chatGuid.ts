/**
 * chat.guid, the chat_id every tool takes: "<service>;<style>;<identifier>". style is "-" for a 1:1 chat and "+" for a
 * group; identifier is the other person's address, or "chatNNN" for a group. The service part varies ("iMessage",
 * "SMS", "RCS", or "any" on newer macOS and for a thread Messages hasn't made yet), so the same conversation can be
 * named with different prefixes.
 */
export interface ChatGuid {
  service: string;
  style: string;
  identifier: string;
}

/**
 * Splits a chat_id. A string with no ";" is all identifier.
 * @example parseChatGuid('iMessage;-;+15555550142') // { service: 'iMessage', style: '-', identifier: '+15555550142' }
 * @example parseChatGuid('any;+;chat58213') // { service: 'any', style: '+', identifier: 'chat58213' }
 */
export function parseChatGuid(guid: string): ChatGuid {
  const first = guid.indexOf(';');
  if (first < 0) return { service: '', style: '', identifier: guid };
  const last = guid.lastIndexOf(';');
  return {
    service: guid.slice(0, first),
    style: first === last ? '' : guid.slice(first + 1, last),
    identifier: guid.slice(last + 1),
  };
}

/**
 * The address or group id at the end of a chat_id (everything after the last ";"; the whole string when there is none).
 * @example chatGuidIdentifier('SMS;-;+15555550142') // '+15555550142'
 */
export const chatGuidIdentifier = (guid: string) => parseChatGuid(guid).identifier;

/**
 * The chat_id without its service prefix (everything after the first ";"), so prefixes can be compared away; undefined
 * when there is no ";".
 * @example chatGuidSuffix('iMessage;+;chat58213') // '+;chat58213'
 */
export function chatGuidSuffix(guid: string): string | undefined {
  const first = guid.indexOf(';');
  return first < 0 ? undefined : guid.slice(first + 1);
}

/**
 * The same conversation whatever the service prefix. Strings without ";" never match.
 * @example sameChatGuid('any;-;+15555550142', 'iMessage;-;+15555550142') // true
 */
export function sameChatGuid(a: string, b: string): boolean {
  const suffix = chatGuidSuffix(a);
  return suffix !== undefined && suffix === chatGuidSuffix(b);
}

/**
 * Whether a reference is shaped like a chat_id rather than a name, person_id or message id.
 * @example isChatGuid('iMessage;-;+15555550142') // true
 */
export const isChatGuid = (s: string) => s.includes(';');

/**
 * The chat_id of a 1:1 thread with an address. With the default "any" it is the id a send result prints before
 * Messages has made the thread.
 * @example dmChatGuid('+15555550142') // 'any;-;+15555550142'
 */
export const dmChatGuid = (address: string, service = 'any') => `${service};-;${address}`;
